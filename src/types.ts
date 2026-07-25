// The shapes a caller hands the kernel. Nothing here is application-specific:
// they describe what a run is *given* (connectors, permissions, a workflow) and
// what it can *emit* (knowledge, issues), not any particular product's domain.
// A host that speaks its own wire protocol re-exports these alongside its own
// contract types, so the two stay structurally aligned.

/**
 * A single external connector the harness can talk to. `kind` distinguishes a
 * Model Context Protocol server from a plain HTTP service; `transport` selects
 * the wire protocol for MCP connectors.
 */
export interface ConnectorConfig {
  name: string
  kind: "mcp" | "http"
  transport: "stdio" | "streamable_http" | "sse"
  /** For streamable_http / sse transports. */
  endpoint?: string
  /** For the stdio transport. */
  command?: string
  args?: string[]
  /** Token is already resolved by the caller; the kernel treats it as opaque. */
  auth?: { type: "bearer" | "none"; token?: string }
}

/**
 * What a run is allowed to touch. `tools` acts as an allowlist of tool names,
 * `hosts` as an egress allowlist for the http_fetch primitive; the open index
 * signature lets callers carry their own policy keys through untouched.
 */
export interface Permissions {
  read?: string[]
  write?: string[]
  tools?: string[]
  /** Egress allowlist (host[:port]) for the http_fetch primitive. */
  hosts?: string[]
  [key: string]: unknown
}

/**
 * A piece of durable knowledge a run chose to record (via the
 * `promote_knowledge` tool or capability). The kernel only collects these into
 * the run's sink and returns them; what a caller does with them — store,
 * review, promote behind an approval gate — is the caller's concern.
 * `content` is required; `title`/`kind` are optional hints.
 */
export interface KnowledgeEntry {
  content: string
  title?: string
  kind?: string
  /** Path to store the entry under (the caller derives one when absent). */
  path?: string
  /** Idempotency key so a re-run doesn't promote the same entry twice. */
  dedupe_key?: string
  /** Attribution label; the caller supplies a default when absent. */
  source?: string
}

/**
 * An operational issue a run chose to open (via the `record_issue` tool or the
 * `open_issue` capability) — the "a human should look at this" surface a run
 * emits. As with knowledge, the kernel only collects them. `title` is required;
 * a stable `dedupe_key` lets a caller UPDATE the same issue on a re-run rather
 * than opening a duplicate.
 */
export interface IssueEntry {
  title: string
  /** Markdown issue body (optional). */
  body?: string
  /** Stable key so a re-run upserts one rolling issue instead of duplicating. */
  dedupe_key?: string
  /** Optional labels for the issue. */
  labels?: string[]
}

/**
 * The declarative description of the work a run performs, as parsed from the
 * caller's own workflow format. The kernel reads only what it needs (the
 * prompt, permissions, provider preference); the remaining fields are carried
 * through for engines and callers that care.
 */
export interface WorkflowDefinition {
  name?: string
  trigger?: { type?: string }
  service?: { exposed?: boolean; name?: string }
  permissions?: Permissions
  autonomy?: { approval_required?: boolean }
  context?: { mode?: string; files?: string[] }
  runner?: { profile?: string }
  provider?: { preferred?: string }
  prompt?: string
  /** Shell commands run in the sandbox BEFORE the agent, to install the run's own
   *  dependencies (e.g. `npm ci`). Runs with the run's secrets in env; a failure
   *  aborts the run (the agent must not run without its deps). */
  setup?: string[]
  /** Shell commands run as a deterministic audit gate after output is produced. */
  verify?: string[]
}
