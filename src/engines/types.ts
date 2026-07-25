import type { ProviderSelection } from "../providers/index.js"
import type {
  ConnectorConfig,
  IssueEntry,
  KnowledgeEntry,
  Permissions,
  WorkflowDefinition,
} from "../types.js"

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
}

/**
 * What an engine returns.
 *
 * NOTE — known residual coupling. `knowledge` and `issues` are shaped by one
 * application's run protocol, which is not something a generic kernel should
 * know. Now that capabilities and domain tools are injected, the application
 * owns the sinks they write to and reads emissions from there; the in-process
 * engines leave these empty. They survive only because the out-of-process
 * engine (codex) still hands back what it read from the emissions file, and
 * genericising that round trip is a wider change than the extraction it would
 * have ridden along with. The intended end state is a single opaque
 * `emissions?: unknown` the kernel never inspects.
 */
export interface EngineResult {
  /** Final assistant prose for the run; the caller writes it as the run artifact. */
  text: string
  /** See the note above: application-shaped, and empty from the in-process engines. */
  knowledge: KnowledgeEntry[]
  /** See the note above: application-shaped, and empty from the in-process engines. */
  issues: IssueEntry[]
}

/** The outcome of an engine's capability check for a given run. */
export type EngineSupport = { ok: true } | { ok: false; reason: string }

/**
 * A pluggable agent harness. Implementations: the in-process native tool-use
 * loop, and (as adapters) Claude Code / Codex. An engine drives the agent to
 * completion against {@link RunSpec.workdir} and returns prose + knowledge;
 * file changes land on disk and are captured by the caller's change-set diff.
 */
export interface AgentEngine {
  readonly name: string
  /** Whether this engine can honour the run's hard requirements (capabilities,
   *  isolation). A false result fails the run rather than degrading silently. */
  supports(spec: RunSpec): EngineSupport
  run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult>
}
