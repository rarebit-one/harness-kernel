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
  /**
   * Token is already resolved by the caller; the kernel treats it as opaque.
   * For a credential that rotates, set `headers` instead of `token`: the
   * kernel asks it for every request (HTTP-family transports only).
   */
  auth?: { type: "bearer" | "none"; token?: string; headers?: ConnectorAuthHeaders }
  /**
   * The client identity announced to the server. Absent means the kernel's
   * default name suffixed with the connector's own name, at version `0.1.0`.
   */
  clientInfo?: { name: string; version?: string }
  /**
   * The server's own tool names (not namespaced) this run may see and call.
   * Absent means every tool the server lists; `[]` means none. A credential
   * usually reaches further than one run needs, so this narrows what the model
   * is shown as well as what it can invoke. An engine that cannot enforce it
   * refuses the run in `supports()` rather than ignore it.
   */
  tools?: string[]
}

/** What the kernel tells a {@link ConnectorAuthHeaders} function when it asks. */
export interface ConnectorAuthRequest {
  /** The connector's `name`. */
  connector: string
  /**
   * True when the server just answered 401 to headers this function gave: the
   * kernel asks once more and retries the request once, so return a fresh
   * credential rather than a cached one.
   */
  refresh: boolean
  /** Aborts when the connection is closed. */
  signal?: AbortSignal
}

/**
 * Returns the headers that authenticate one request to an MCP server, e.g.
 * `{ Authorization: "Bearer …" }`. Called before every request the transport
 * makes, so cache inside it if minting is expensive. Every value is masked in
 * what the run's tools hand back to the model, so return only credential
 * headers. A throw fails that request with a message naming the connector,
 * not the error.
 */
export type ConnectorAuthHeaders = (
  request: ConnectorAuthRequest,
) => Record<string, string> | Promise<Record<string, string>>

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
  /** Shell commands meant to run in the sandbox BEFORE the agent, to install the
   *  run's own dependencies (e.g. `npm ci`). The kernel carries this and never
   *  executes it: the caller runs it before `engine.run`, with the run's secrets
   *  in env, and should abort the run on failure (the agent must not run without
   *  its deps). */
  setup?: string[]
  /** Shell commands meant to run as a deterministic audit gate after output is
   *  produced. The kernel carries this and never executes it: the caller runs it
   *  after `engine.run` and decides what a failure means. */
  verify?: string[]
}
