import type { ConnectorConfig, IssueEntry, KnowledgeEntry } from "../types.js"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"
import { defaultClaudeCodeDriver } from "./claudeCodeDriver.js"
import { capabilityTools, type CapabilityTool } from "./capability.js"

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
  /** API key (per-org BYO, else the runner env key). */
  apiKey?: string
  /** Tool allowlist; undefined means the harness's defaults. */
  allowedTools?: string[]
  /** Wall-clock budget in ms; undefined means no engine-imposed limit. */
  maxDurationMs?: number
  /** Runner-hosted, workspace-scoped capabilities (open_issue/write_file/promote_knowledge)
   *  the driver mounts as an in-process MCP server so this engine can emit like native. */
  mcpTools?: CapabilityTool[]
  /** The run's external MCP connectors; the driver mounts them as SDK mcpServers so
   *  they become tools inside Claude Code (parity with the native engine). */
  connectors?: ConnectorConfig[]
}

/** A normalized message from the harness (driver-agnostic). */
export type ClaudeCodeMessage =
  { kind: "assistant"; text: string } | { kind: "result"; text: string; isError: boolean }

/**
 * The injectable boundary to the Claude Code harness: given mapped options, yield
 * a normalized message stream. The default implementation drives the Agent SDK;
 * tests inject a fake so no CLI/network runs.
 */
export type ClaudeCodeDriver = (opts: ClaudeCodeOptions) => AsyncIterable<ClaudeCodeMessage>

const DEFAULT_MODEL = "claude-opus-4-8"
const LOG_TRUNCATE = 2000

/**
 * Drives a run with the Claude Code harness (its own grep/glob/edit/bash tools +
 * tuned loop) against the sandbox working tree. File edits land on disk and are
 * captured by the caller's change-set diff — the engine returns prose only.
 *
 * Claude Code runs arbitrary bash, so it must not run on the warm shared runner.
 * `supports()` refuses unless (a) the operator has explicitly enabled it and (b)
 * the run is on the `ephemeral` runner profile (one throwaway container per run —
 * the container, not a human, is the safety boundary). The SDK is loaded lazily by
 * the driver, so this module stays cheap to import on the warm runner.
 */
export class ClaudeCodeEngine implements AgentEngine {
  readonly name = "claude-code"

  private readonly drive: ClaudeCodeDriver

  constructor(drive: ClaudeCodeDriver = defaultClaudeCodeDriver) {
    this.drive = drive
  }

  supports(spec: RunSpec): EngineSupport {
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
    return { ok: true }
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    const apiKey = spec.provider.credentials?.anthropic ?? process.env.ANTHROPIC_API_KEY
    const model = spec.provider.model || DEFAULT_MODEL
    const allowedTools =
      Array.isArray(spec.permissions.tools) && spec.permissions.tools.length > 0
        ? spec.permissions.tools
        : undefined

    // The capability handlers write into these sinks (via the runner-hosted MCP
    // server the driver mounts); we return them so the caller routes issues
    // and knowledge exactly as it does for the native engine — engine parity for emit.
    const knowledge: KnowledgeEntry[] = []
    const issues: IssueEntry[] = []
    const mcpTools = capabilityTools({
      workspaceId: spec.workspaceId,
      workdir: spec.workdir,
      issues,
      knowledge,
    })

    const options: ClaudeCodeOptions = {
      prompt: buildPrompt(spec),
      cwd: spec.workdir,
      model,
      mcpTools,
      ...(spec.connectors.length > 0 ? { connectors: spec.connectors } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(spec.limits?.maxDurationMs !== undefined
        ? { maxDurationMs: spec.limits.maxDurationMs }
        : {}),
    }

    ctx.log(`claude-code: driving model ${model} in ${spec.workdir}`)

    let finalText = ""

    for await (const message of this.drive(options)) {
      if (message.kind === "assistant") {
        if (message.text) ctx.log(`claude-code: ${truncate(message.text, LOG_TRUNCATE)}`)
      } else {
        finalText = message.text
        if (message.isError) ctx.log("claude-code: harness reported an error")
      }
    }

    return { text: finalText || "(no output)", knowledge, issues }
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
