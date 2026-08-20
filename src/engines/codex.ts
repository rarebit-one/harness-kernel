import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"
import { connectorServers, writeCodexConfig, type SerializableMcpServer } from "./connectorMcp.js"
import { readEmissions } from "./capabilityEmissions.js"
import { defaultCodexDriver } from "./codexDriver.js"

/**
 * Driver-neutral options the engine derives from a {@link RunSpec} and hands to
 * the codex harness. The default driver maps these onto the OpenAI Codex CLI;
 * tests inject a fake driver and assert this mapping.
 */
export interface CodexOptions {
  /** The task prompt (workflow prompt + inputs). */
  prompt: string
  /** The prepared sandbox working tree — the harness's cwd; edits land here. */
  cwd: string
  /** Model id (resolved: per-run model, else the engine default). */
  model: string
  /** API key (per-org BYO, else the runner env key). */
  apiKey?: string
  /**
   * The transient `CODEX_HOME` for this run — a temp dir OUTSIDE the sandbox that
   * holds the `config.toml` the engine wrote (the run's MCP servers). The driver
   * points the codex process at it via the `CODEX_HOME` env var.
   */
  codexHome: string
  /**
   * Env the runner-hosted capability stdio MCP server needs (workspace id, workdir,
   * emissions-file path). These are ALSO declared in the server's `config.toml` env
   * table, but the driver sets them on the codex process env too so the spawned
   * server inherits them even if codex doesn't forward the config env table.
   */
  capabilityEnv: Record<string, string>
  /** Wall-clock budget in ms; undefined means no engine-imposed limit. */
  maxDurationMs?: number
}

/** A normalized message from the harness (driver-agnostic). */
export type CodexMessage =
  { kind: "assistant"; text: string } | { kind: "result"; text: string; isError: boolean }

/** The injectable boundary to the codex harness. Tests supply a fake. */
export type CodexDriver = (opts: CodexOptions) => AsyncIterable<CodexMessage>

const DEFAULT_MODEL = "gpt-5-codex"
const LOG_TRUNCATE = 2000

/** The runner-hosted capability MCP server the codex `config.toml` points at. */

/**
 * Drives a run with the OpenAI Codex CLI against the sandbox working tree,
 * mirroring the Claude Code engine. Because codex runs as an EXTERNAL process, it
 * reaches the run's tools through a `config.toml` the engine writes into a transient
 * `CODEX_HOME` (codex's REAL MCP discovery mechanism — it ignores `.mcp.json`):
 * the run's connectors (Pillar 4) plus the runner-hosted, workspace-scoped
 * capability server (Pillar 3) as a stdio MCP server. The capability server
 * persists issue/knowledge emits to a file outside the tree, which this engine
 * reads back — so codex reaches emit parity with native and Claude Code.
 *
 * Codex runs arbitrary code, so — like Claude Code — `supports()` refuses unless
 * the operator enabled it (RUNNER_ENABLE_CODEX=1) AND the run is on the ephemeral
 * runner profile (one throwaway container per run is the safety boundary).
 */
export class CodexEngine implements AgentEngine {
  readonly name = "codex"

  private readonly drive: CodexDriver
  private readonly capabilityServerScript: string

  /**
   * `capabilityServerScript` is REQUIRED: the capability surface is injected,
   * and a child process cannot be handed a closure, so the application must
   * supply the entrypoint that builds and serves its own tools. There is no
   * sensible kernel default — one would silently serve an empty surface.
   */
  constructor(drive: CodexDriver = defaultCodexDriver, capabilityServerScript: string) {
    this.drive = drive
    this.capabilityServerScript = capabilityServerScript
  }

  supports(spec: RunSpec): EngineSupport {
    if (process.env.RUNNER_ENABLE_CODEX !== "1") {
      return { ok: false, reason: "codex engine is disabled (set RUNNER_ENABLE_CODEX=1)" }
    }
    if (spec.workflow.runner?.profile !== "ephemeral") {
      return {
        ok: false,
        reason: "codex engine requires the ephemeral runner profile (per-run container isolation)",
      }
    }
    return { ok: true }
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    const apiKey = spec.provider.credentials?.openai ?? process.env.OPENAI_API_KEY
    const model = spec.provider.model || DEFAULT_MODEL

    // Emissions land OUTSIDE the sandbox so the bookkeeping file is never captured
    // by the change set; the capability server (an external process) writes here and
    // we read it back after the run.
    const emissionsDir = await mkdtemp(path.join(tmpdir(), "harness-emit-"))
    const emissionsFile = path.join(emissionsDir, "emissions.json")

    // The codex `config.toml` carries resolved connector auth tokens, so it lives in
    // a transient CODEX_HOME OUTSIDE the sandbox — it can never reach the change set —
    // and is deleted in `finally` regardless.
    //
    // On /tmp, codex logs one harmless warning per run ("Refusing to create helper
    // binaries under temporary dir /tmp") and PROCEEDS: it only skips creating the
    // PATH-alias helper binaries, which we never use. Kept on /tmp deliberately —
    // relocating off /tmp (e.g. to the `node` user's home in the container) would
    // silence the log but flip codex into actually writing those unneeded helpers
    // every run, and couple this to assumptions about the runtime image's writable
    // dirs. The warning is purely cosmetic; not worth that trade.
    const codexHome = await mkdtemp(path.join(tmpdir(), "harness-codex-home-"))
    // The env the capability stdio server needs — set both in its config.toml env
    // table AND on the codex process env (see CodexOptions.capabilityEnv) so it
    // arrives regardless of whether codex forwards the config env table.
    const capabilityEnv: Record<string, string> = {
      HARNESS_WORKSPACE_ID: spec.workspaceId,
      HARNESS_WORKDIR: spec.workdir,
      HARNESS_EMISSIONS_FILE: emissionsFile,
    }
    const servers: Record<string, SerializableMcpServer> = {
      ...connectorServers(spec.connectors),
      [CAPABILITY_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [this.capabilityServerScript],
        env: capabilityEnv,
      },
    }
    await writeCodexConfig(codexHome, servers)

    const options: CodexOptions = {
      prompt: buildPrompt(spec),
      cwd: spec.workdir,
      model,
      codexHome,
      capabilityEnv,
      ...(apiKey ? { apiKey } : {}),
      ...(spec.limits?.maxDurationMs !== undefined
        ? { maxDurationMs: spec.limits.maxDurationMs }
        : {}),
    }

    ctx.log(`codex: driving model ${model} in ${spec.workdir}`)

    let finalText = ""
    try {
      for await (const message of this.drive(options)) {
        if (message.kind === "assistant") {
          if (message.text) ctx.log(`codex: ${truncate(message.text, LOG_TRUNCATE)}`)
        } else {
          finalText = message.text
          if (message.isError) ctx.log("codex: harness reported an error")
        }
      }
    } finally {
      // The token-bearing config is transient — never let it linger.
      await rm(codexHome, { recursive: true, force: true })
    }

    // The stat's SIZE is the log's byte count, for two reasons. It is the only
    // honest one — `JSON.stringify(x).length` counts UTF-16 code units, not
    // bytes, and under-reports anything outside the BMP. And measuring by
    // re-serializing allocates a second copy of a payload that may be large,
    // to produce a number we already have on disk.
    const emissionsStat = await stat(emissionsFile).then(
      (st) => st,
      () => undefined,
    )
    const emissions = await readEmissions(emissionsFile)
    // The engine reports whether the round trip HAPPENED, not what it carried:
    // counting entries would mean knowing the shape, which is the coupling this
    // is rid of. Presence plus size separates "the server never wrote" from "it
    // wrote and the run emitted nothing".
    ctx.log(
      `codex: capability emissions — file ${emissionsStat ? `present (${emissionsStat.size} bytes)` : "absent"}` +
        `${emissionsStat && emissions === undefined ? ", unreadable" : ""}`,
    )
    await rm(emissionsDir, { recursive: true, force: true })

    return {
      text: finalText || "(no output)",
      ...(emissions !== undefined ? { emissions } : {}),
    }
  }
}

function buildPrompt(spec: RunSpec): string {
  const inputs = JSON.stringify(spec.inputs ?? {}, null, 2)
  return [
    spec.workflow.prompt ?? `Execute the "${spec.workflow.name ?? spec.workflowPath}" workflow.`,
    "",
    "## Inputs",
    "```json",
    inputs,
    "```",
    "",
    "You are running as an autonomous workflow. The current working directory is the",
    "workspace — inspect and edit its files directly with your tools. When finished,",
    "reply with the workflow's output as Markdown.",
  ].join("\n")
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
