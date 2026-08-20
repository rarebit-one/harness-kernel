// The shapes a caller hands the kernel: what a run is *given* — connectors,
// permissions, a workflow. Nothing here is application-specific.
//
// What a run *emits* used to live here too, as `KnowledgeEntry` and
// `IssueEntry`. It doesn't any more: those were one product's vocabulary, and a
// kernel that names them has already lost the argument. Emissions are opaque —
// see `EngineResult.emissions`. A host defines its own emission shapes and
// casts.

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
