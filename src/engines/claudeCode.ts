import { refusePrivateRun } from "../private.js"
import { refuseUnisolated } from "./isolation.js"
import type { RunOutcome } from "../events.js"
import { harnessOutcome, type StoppedBy } from "../signals.js"
import type { ConnectorConfig } from "../types.js"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"
import { defaultClaudeCodeDriver } from "./claudeCodeDriver.js"
import { writeFileCapability, type CapabilityContext, type CapabilityTool } from "./capability.js"
import { harnessPrompt } from "./harnessPrompt.js"
import { environmentInstructions, hasEnvironment, writeSkills } from "./environment.js"
import { gatewayEnv, refuseBadGateway, refuseRawCredentialsInVm } from "./gateway.js"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Driver-neutral options the engine derives from a {@link RunSpec} and hands to
 * the Claude Code harness. The default driver maps these onto the Anthropic Agent
 * SDK; tests inject a fake driver and assert this mapping.
 */
export interface ClaudeCodeOptions {
  /** The task prompt (workflow prompt + inputs). */
  prompt: string
  /** The prepared sandbox working tree — the harness's cwd; edits land here. */
  cwd: string
  /** Model id (resolved: per-run model, else the engine default). */
  model: string
  /** API key (per-org BYO, else the runner env key). Never set when the run has a gateway. */
  apiKey?: string
  /**
   * The gateway env (base URL + run token) when the run has a credential
   * gateway: the driver sets it INSTEAD of any key, and stops inheriting the
   * host's `ANTHROPIC_*` settings so nothing can route around it.
   */
  gatewayEnv?: Record<string, string>
  /** Tool allowlist; undefined means the harness's defaults. */
  allowedTools?: string[]
  /** Wall-clock budget in ms; undefined means no engine-imposed limit. */
  maxDurationMs?: number
  /** Workspace-scoped capabilities the driver mounts as an in-process MCP server.
   *  Which ones is the application's choice — see {@link CapabilityToolFactory}. */
  mcpTools?: CapabilityTool[]
  /** The run's external MCP connectors; the driver mounts them as SDK mcpServers so
   *  they become tools inside Claude Code (parity with the native engine). */
  connectors?: ConnectorConfig[]
  /** The caller's cancel; the driver merges it with its own `maxDurationMs` timer. */
  signal?: AbortSignal
  /**
   * Appended to Claude Code's own system prompt: the run's environment
   * instructions (and its `AGENTS.md` text, which Claude Code does not read).
   * Set only when the run has an environment.
   */
  systemPromptAppend?: string
  /**
   * Which on-disk settings Claude Code loads. Set to `["project"]` only when
   * the run has an environment, so the workspace's own `CLAUDE.md` and
   * `.claude/` apply but the host's user settings do not.
   */
  settingSources?: Array<"user" | "project" | "local">
  /** Local plugin directories to load: the run's skills. Outside the workdir. */
  pluginDirs?: string[]
}

/** A normalized message from the harness (driver-agnostic). */
export type ClaudeCodeMessage =
  | { kind: "assistant"; text: string }
  | {
      kind: "result"
      text: string
      isError: boolean
      /** Set when the driver stopped the harness early: its own timer
       *  (`"deadline"`) or the caller's signal (`"signal"`). */
      stoppedBy?: StoppedBy
    }

/**
 * The injectable boundary to the Claude Code harness: given mapped options, yield
 * a normalized message stream. The default implementation drives the Agent SDK;
 * tests inject a fake so no CLI/network runs.
 */
export type ClaudeCodeDriver = (opts: ClaudeCodeOptions) => AsyncIterable<ClaudeCodeMessage>

const DEFAULT_MODEL = "claude-opus-4-8"
const LOG_TRUNCATE = 2000

/**
 * Builds the capability surface a run gets, bound to that run's workspace scope
 * and working tree. The kernel supplies only the generic
 * {@link writeFileCapability}; an application injects a factory that composes
 * its own capabilities alongside it, closing over whatever sinks it wants the
 * emissions to land in.
 */
export type CapabilityToolFactory = (ctx: CapabilityContext) => CapabilityTool[]

/** The kernel's default surface: the one capability that carries no product semantics. */
export const defaultCapabilityTools: CapabilityToolFactory = (ctx) => [writeFileCapability(ctx)]

/**
 * Drives a run with the Claude Code harness (its own grep/glob/edit/bash tools +
 * tuned loop) against the sandbox working tree. File edits land on disk and are
 * captured by the caller's change-set diff — the engine returns prose only.
 *
 * Claude Code runs arbitrary bash, so it must not run on the warm shared runner.
 * `supports()` refuses unless (a) the operator has explicitly enabled it, (b)
 * the workflow asks for the `ephemeral` runner profile, and (c) the run really
 * has at least container isolation, asserted by both the caller and the host
 * (see `refuseUnisolated`). The box, not a human, is the safety boundary.
 * The SDK is loaded lazily by the driver, so this module stays cheap to import
 * on the warm runner.
 */
export class ClaudeCodeEngine implements AgentEngine {
  readonly name = "claude-code"

  private readonly drive: ClaudeCodeDriver
  private readonly capabilityTools: CapabilityToolFactory

  constructor(
    drive: ClaudeCodeDriver = defaultClaudeCodeDriver,
    capabilityTools: CapabilityToolFactory = defaultCapabilityTools,
  ) {
    this.drive = drive
    this.capabilityTools = capabilityTools
  }

  supports(spec: RunSpec): EngineSupport {
    const refusal = refusePrivateRun("claude-code", spec)
    if (refusal) return refusal
    if (process.env.RUNNER_ENABLE_CLAUDE_CODE !== "1") {
      return {
        ok: false,
        reason: "claude-code engine is disabled (set RUNNER_ENABLE_CLAUDE_CODE=1)",
      }
    }
    if (spec.workflow.runner?.profile !== "ephemeral") {
      return {
        ok: false,
        reason:
          "claude-code engine requires the ephemeral runner profile (per-run container isolation)",
      }
    }
    return (
      refuseUnisolated("claude-code", spec) ??
      refuseBadGateway("claude-code", spec) ??
      refuseRawCredentialsInVm("claude-code", spec, ["ANTHROPIC_API_KEY"]) ?? { ok: true }
    )
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    // With a gateway the harness holds the run token and nothing else: no BYO
    // key, and no fallback to the host's own.
    const apiKey = spec.gateway
      ? undefined
      : (spec.provider.credentials?.anthropic ?? process.env.ANTHROPIC_API_KEY)
    const model = spec.provider.model || DEFAULT_MODEL
    const allowedTools =
      Array.isArray(spec.permissions.tools) && spec.permissions.tools.length > 0
        ? spec.permissions.tools
        : undefined

    // No emissions from here: injected capabilities close over sinks the
    // APPLICATION owns, so it reads what a run emitted from those directly.
    // Omitted rather than returned empty — see EngineResult.
    const mcpTools = this.capabilityTools({
      workspaceId: spec.workspaceId,
      workdir: spec.workdir,
    })

    const options: ClaudeCodeOptions = {
      prompt: harnessPrompt(spec),
      cwd: spec.workdir,
      model,
      mcpTools,
      ...(spec.connectors.length > 0 ? { connectors: spec.connectors } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(spec.gateway ? { gatewayEnv: gatewayEnv(spec.gateway, ["anthropic"]) } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(spec.limits?.maxDurationMs !== undefined
        ? { maxDurationMs: spec.limits.maxDurationMs }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }

    // The environment, compiled for Claude Code: instructions on its system
    // prompt and skills as a local plugin in a transient dir OUTSIDE the
    // sandbox, so neither can reach the change set. Nothing when the run has
    // no environment: the options are exactly what they always were.
    let pluginRoot: string | undefined
    if (hasEnvironment(spec)) {
      options.settingSources = ["project"]
      const append = environmentInstructions(spec, { agentsMd: true, skillsIndex: false })
      if (append) options.systemPromptAppend = append
      if (spec.skills && spec.skills.length > 0) {
        pluginRoot = await mkdtemp(path.join(tmpdir(), "harness-skills-"))
        await writeSkillsPlugin(pluginRoot, spec)
        options.pluginDirs = [pluginRoot]
        ctx.log(`claude-code: ${spec.skills.length} skill(s) mounted as a local plugin`)
      }
    }

    ctx.log(`claude-code: driving model ${model} in ${spec.workdir}`)

    let finalText = ""
    let lastAssistantText = ""
    let outcome: RunOutcome = "completed"

    try {
      for await (const message of this.drive(options)) {
        if (message.kind === "assistant") {
          if (message.text) {
            lastAssistantText = message.text
            ctx.log(`claude-code: ${truncate(message.text, LOG_TRUNCATE)}`)
          }
        } else {
          finalText = message.text
          outcome = harnessOutcome(message.isError, message.stoppedBy)
          if (message.stoppedBy) ctx.log(`claude-code: stopped (${outcome})`)
          else if (message.isError) ctx.log("claude-code: harness reported an error")
        }
      }
    } catch (err) {
      // A driver that throws on the caller's abort was still canceled, not broken.
      if (!ctx.signal?.aborted) throw err
      outcome = "canceled"
      ctx.log("claude-code: stopped (canceled)")
    } finally {
      if (pluginRoot) await rm(pluginRoot, { recursive: true, force: true })
    }

    const stopped = outcome === "canceled" || outcome === "timed_out"
    return {
      text: finalText || (stopped ? lastAssistantText : "") || "(no output)",
      outcome,
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** The plugin the run's skills are mounted as. Brand-neutral by construction. */
export const SKILLS_PLUGIN_NAME = "run-skills"

/**
 * A minimal local plugin holding the run's skills: a manifest plus
 * `skills/<name>/…`, which Claude Code discovers like any plugin's skills.
 */
async function writeSkillsPlugin(root: string, spec: RunSpec): Promise<void> {
  const manifestDir = path.join(root, ".claude-plugin")
  await writeSkills(path.join(root, "skills"), spec.skills ?? [])
  await mkdir(manifestDir, { recursive: true })
  await writeFile(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify({ name: SKILLS_PLUGIN_NAME, description: "Skills for this run" }, null, 2)}\n`,
  )
}
