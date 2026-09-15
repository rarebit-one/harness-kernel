import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { McpServer } from "@zed-industries/agent-client-protocol"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"
import { connectorServers, type SerializableMcpServer } from "./connectorMcp.js"
import { readEmissions } from "./capabilityEmissions.js"
import { defaultAcpDriver } from "./acpDriver.js"

const LOG_TRUNCATE = 2000

/**
 * A named external agent this engine can drive over the Agent Client Protocol.
 * ACP is a JSON-RPC-over-stdio protocol between a *client* (this engine) and a
 * coding *agent* running as a separate process, so every ACP agent reduces to
 * "which subprocess to spawn, with what argv and env". The capability MCP server
 * and the run's connectors are handed to the agent through `session/new`, so a
 * spec never has to describe those — only its own launch.
 *
 * External agent product names appearing here follow the existing `claude-code`
 * / `codex` precedent: an adapter's honest identity is the tool it drives, not a
 * consumer's brand.
 */
export interface AcpAgentSpec {
  /** Engine name; also the `provider.engine` value that selects it. */
  readonly name: string
  /** Env var that must equal `"1"` for {@link AcpEngine.supports} to allow this agent. */
  readonly enableEnv: string
  /** The executable to spawn — an ACP server over stdio. */
  readonly command: string
  /** The process argv for a run (e.g. the ACP subcommand). */
  args(spec: RunSpec): string[]
  /** Extra process env — e.g. the provider credentials the agent reads for itself. */
  env(spec: RunSpec): Record<string, string>
}

/**
 * Driver-neutral options the engine derives from a {@link RunSpec} and hands to
 * the ACP driver. The default driver spawns `command`+`args` and speaks ACP over
 * its stdio; tests inject a fake driver and assert this mapping.
 */
export interface AcpOptions {
  command: string
  args: string[]
  env: Record<string, string>
  /** The prepared sandbox working tree — the agent's cwd and ACP `session/new` cwd. */
  cwd: string
  /** The run's MCP servers (connectors + the capability server) for `session/new`. */
  mcpServers: McpServer[]
  /** The task prompt (workflow prompt + inputs). */
  prompt: string
  /** Wall-clock budget in ms; undefined means no engine-imposed limit. */
  maxDurationMs?: number
  /** Append a line to the run log (the driver surfaces the agent's stderr here). */
  log: (line: string) => void
}

/** Streaming callbacks the driver invokes as ACP `session/update`s arrive. */
export interface AcpClientEvents {
  /** An `agent_message_chunk` — accumulated into the run's prose result. */
  onAssistantChunk(text: string): void
  /** A human-readable line for the run log (thoughts, tool-call titles). */
  onLog(line: string): void
}

/** What one ACP prompt turn resolved to. */
export interface AcpOutcome {
  /** The ACP `stopReason` (`end_turn`, `cancelled`, `refusal`, …). */
  stopReason: string
}

/** The injectable boundary to the ACP transport. Tests supply a fake. */
export type AcpDriver = (opts: AcpOptions, events: AcpClientEvents) => Promise<AcpOutcome>

/**
 * Drives a run with any ACP-speaking coding agent (Claude Code, Codex, eve, …)
 * against the sandbox working tree. One engine, one transport: where the codex
 * engine wrote a `config.toml` and the Claude Code engine mounted an in-process
 * SDK MCP server, this hands the run's connectors + the runner-hosted capability
 * server to the agent through the ACP `session/new` `mcpServers` field, and reads
 * back the capability server's emissions file — so an ACP agent reaches emit
 * parity with native.
 *
 * Because an ACP agent runs arbitrary code, `supports()` refuses unless the
 * operator enabled this specific agent AND the run is on the ephemeral runner
 * profile (one throwaway container per run is the safety boundary). File edits
 * are out-of-band: the agent edits `cwd` directly and the caller's change-set
 * diff captures them, so this engine advertises no client filesystem capability.
 */
export class AcpEngine implements AgentEngine {
  readonly name: string

  private readonly agent: AcpAgentSpec
  private readonly capabilityServerScript: string
  private readonly drive: AcpDriver

  /**
   * `capabilityServerScript` is REQUIRED, exactly as for codex: the capability
   * surface is injected, and a child process cannot be handed a closure, so the
   * application must supply the entrypoint that serves its own tools over stdio.
   */
  constructor(
    agent: AcpAgentSpec,
    capabilityServerScript: string,
    drive: AcpDriver = defaultAcpDriver,
  ) {
    this.agent = agent
    this.name = agent.name
    this.capabilityServerScript = capabilityServerScript
    this.drive = drive
  }

  supports(spec: RunSpec): EngineSupport {
    if (process.env[this.agent.enableEnv] !== "1") {
      return {
        ok: false,
        reason: `${this.name} engine is disabled (set ${this.agent.enableEnv}=1)`,
      }
    }
    if (spec.workflow.runner?.profile !== "ephemeral") {
      return {
        ok: false,
        reason: `${this.name} engine requires the ephemeral runner profile (per-run container isolation)`,
      }
    }
    return { ok: true }
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    // Emissions land OUTSIDE the sandbox so the bookkeeping file is never captured
    // by the change set; the capability server (an external process) writes here and
    // we read it back after the run.
    const emissionsDir = await mkdtemp(path.join(tmpdir(), "harness-emit-"))
    const emissionsFile = path.join(emissionsDir, "emissions.json")
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

    const options: AcpOptions = {
      command: this.agent.command,
      args: this.agent.args(spec),
      // The capability env also rides on the process env so the stdio capability
      // server inherits it regardless of how the agent forwards `session/new` env.
      env: { ...this.agent.env(spec), ...capabilityEnv },
      cwd: spec.workdir,
      mcpServers: toAcpMcpServers(servers),
      prompt: buildPrompt(spec),
      ...(spec.limits?.maxDurationMs !== undefined
        ? { maxDurationMs: spec.limits.maxDurationMs }
        : {}),
      log: ctx.log,
    }

    ctx.log(`${this.name}: driving ACP agent in ${spec.workdir}`)

    const chunks: string[] = []
    const outcome = await this.drive(options, {
      onAssistantChunk: (text) => {
        if (text) chunks.push(text)
      },
      onLog: (line) => {
        if (line) ctx.log(`${this.name}: ${truncate(line, LOG_TRUNCATE)}`)
      },
    })

    if (outcome.stopReason && outcome.stopReason !== "end_turn") {
      ctx.log(`${this.name}: stopped (${outcome.stopReason})`)
    }

    // Report whether the emissions round trip HAPPENED, not what it carried —
    // presence plus size separates "the server never wrote" from "it wrote and the
    // run emitted nothing"; the byte count comes from the file (see codex engine).
    const emissionsStat = await stat(emissionsFile).then(
      (st) => st,
      () => undefined,
    )
    const emissions = await readEmissions(emissionsFile)
    ctx.log(
      `${this.name}: capability emissions — file ${emissionsStat ? `present (${emissionsStat.size} bytes)` : "absent"}` +
        `${emissionsStat && emissions === undefined ? ", unreadable" : ""}`,
    )
    await rm(emissionsDir, { recursive: true, force: true })

    return {
      text: chunks.join("").trim() || "(no output)",
      ...(emissions !== undefined ? { emissions } : {}),
    }
  }
}

/**
 * Translate the run's serializable MCP servers into ACP's `McpServer[]`. Same
 * source data every other engine consumes (`connectorServers`), reshaped to the
 * ACP wire form: env and headers become `{ name, value }` arrays.
 */
function toAcpMcpServers(servers: Record<string, SerializableMcpServer>): McpServer[] {
  return Object.entries(servers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      }
    }
    return {
      name,
      type: server.type,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    }
  })
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

/**
 * The eve agent (Vercel's open-source framework), driven over `eve acp` — its
 * stdio ACP server surface. eve reads its own model/provider from the authored
 * eve application in the workdir; we pass through whatever provider credentials
 * the run carries so a BYO key reaches it. (Open: an eve "agent" is an authored
 * app, so the workdir must contain one — a workflow-declared app path with an
 * `agent/`-root default is the follow-up; today it runs the app at the workdir root.)
 */
export const EVE_AGENT: AcpAgentSpec = {
  name: "eve",
  enableEnv: "RUNNER_ENABLE_EVE",
  command: "eve",
  args: () => ["acp"],
  env: (spec) => {
    const env: Record<string, string> = {}
    const creds = spec.provider.credentials
    if (creds?.anthropic) env.ANTHROPIC_API_KEY = creds.anthropic
    if (creds?.openai) env.OPENAI_API_KEY = creds.openai
    if (creds?.openrouter) env.OPENROUTER_API_KEY = creds.openrouter
    return env
  },
}
