# Connectors

`mcpClient.ts` is the kernel's MCP **client** — it connects to external MCP
servers (described by a `ConnectorConfig`) over `stdio`, `streamable_http`, or
`sse`, and exposes `listTools()` / `callTool()`.

The caller owns the connector lifecycle: it stores connector records, runs any
OAuth flow, and resolves a **fresh bearer token** into `ConnectorConfig.auth.token`
before each run. The kernel treats tokens as opaque and only attaches them (as a
request header for HTTP transports, or an env var for stdio).

`connectorTools()` in [`../tools/registry.ts`](../tools/registry.ts) turns a set
of connectors into agent tools, namespaced `<connector>__<tool>` to avoid
collisions, and returns a `close()` for the caller to invoke when the run ends.
The native engine merges them with the general-purpose primitives, so the model
can call connector tools mid-run alongside `run_code` / `http_fetch` / `fs`.
Connector tools are **not** re-gated by `permissions.tools`: authorization
(scope + grants) already happened when the caller populated `connectors`.

Not to be confused with `../engines/capabilityMcp.ts` and
`../engines/capabilityStdio.ts` — those host the kernel's *own* capability tools
**as** an MCP server, for engines that consume tools that way (Claude Code,
codex). This file is the opposite direction: consuming someone else's server.
