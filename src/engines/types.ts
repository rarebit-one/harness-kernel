import type { RunEventSink } from "../events.js"
import type { ProviderSelection } from "../providers/index.js"
import type { ConnectorConfig, Permissions, WorkflowDefinition } from "../types.js"

/**
 * The provider-neutral, harness-neutral description of one workflow run, handed
 * to an {@link AgentEngine}. It carries the *materials* (a prepared on-disk
 * working tree, the workflow, assembled context, permissions, secrets,
 * connectors, provider selection) — NOT a fixed prompt or tool set, which are
 * each engine's own concern.
 *
 * Crucially, file mutations are out-of-band: an engine edits files under
 * {@link RunSpec.workdir} and the caller (executeRun) computes the change set by
 * diffing that tree against the input manifest. So the engine contract never
 * has to model "an edit" uniformly across the native loop, Claude Code, or Codex.
 */
export interface RunSpec {
  runId: string
  workspaceId: string
  workflowPath: string
  /** The parsed workflow YAML (prompt, runner profile, verify steps, …). */
  workflow: WorkflowDefinition
  /** The run's structured inputs (context_bundle.inputs). */
  inputs: Record<string, unknown>
  /** Pre-assembled curated context text. The native loop bakes it into the
   *  prompt; a filesystem-native engine (Claude Code) may ignore it and explore. */
  context: string
  /** Absolute path to the prepared sandbox working tree (the engine edits here). */
  workdir: string
  permissions: Permissions
  /** Workflow-declared secrets, resolved by the caller. */
  secrets: Record<string, string>
  /** Connectors (MCP/HTTP) with auth tokens already resolved. */
  connectors: ConnectorConfig[]
  /** Preferred provider + per-run model + per-org BYO keys. */
  provider: { preferred?: string | null } & ProviderSelection
  /** Optional budget overrides; engines that don't honour these ignore them. */
  limits?: { maxSteps?: number; maxDurationMs?: number }
}

export interface EngineContext {
  /** Append a timestamped line to the run's logs. */
  log: (line: string) => void
  /**
   * Optional structured event sink for the run.
   *
   * `log` is prose for a human; this is the machine-readable account of the
   * same run. Optional so every existing caller and every existing engine
   * compiles and behaves unchanged — an engine that has nothing structured to
   * say simply never calls it, and a caller that wants only logs omits it.
   *
   * Engines differ in what they can honour, and that is expected rather than a
   * gap to close: the in-process loop emits the full stream because it sees
   * every turn and every tool call, whereas an out-of-process engine only sees
   * what its transport surfaces. An engine emitting a subset is not degrading
   * silently — the events it does emit are exact.
   */
  emit?: RunEventSink
}

/**
 * What an engine returns.
 *
 * `text` is the run's prose — the one thing every engine has. `emissions` is
 * whatever else the run produced, and the kernel **never inspects it**: what a
 * run may emit is the application's vocabulary, not the kernel's.
 *
 * This used to be `knowledge: KnowledgeEntry[]` and `issues: IssueEntry[]` —
 * one application's run protocol, in the kernel's own return type, which the
 * comment here admitted was wrong and named this as the intended end state. The
 * in-process engines left them empty and only the out-of-process engine filled
 * them, so the fields cost every engine a shape they had no use for.
 *
 * Opaque means opaque: the kernel does not parse, validate, or default it. An
 * engine that has nothing to hand back omits it, and a caller casts it to
 * whatever its own capability surface agreed to write.
 */
export interface EngineResult {
  /** Final assistant prose for the run; the caller writes it as the run artifact. */
  text: string
  /** Anything else the run produced, in the application's own shape. */
  emissions?: unknown
}

/** The outcome of an engine's capability check for a given run. */
export type EngineSupport = { ok: true } | { ok: false; reason: string }

/**
 * A pluggable agent harness. Implementations: the in-process native tool-use
 * loop, and (as adapters) Claude Code / Codex. An engine drives the agent to
 * completion against {@link RunSpec.workdir} and returns prose plus whatever
 * else the run emitted; file changes land on disk and are captured by the
 * caller's change-set diff.
 */
export interface AgentEngine {
  readonly name: string
  /** Whether this engine can honour the run's hard requirements (capabilities,
   *  isolation). A false result fails the run rather than degrading silently. */
  supports(spec: RunSpec): EngineSupport
  run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult>
}
