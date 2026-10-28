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

A credential usually reaches further than one run needs, so a caller can narrow
a connector with `ConnectorConfig.tools`: the server's own tool names this run
may see and call (`[]` for none, absent for all). `connectorTools()` drops every
other tool before the model sees the catalog, which also keeps unused tool
schemas out of the context. The out-of-process engines (Claude Code, codex, ACP
agents) mount a connector as a whole server and cannot honour the list, so they
refuse such a run in `supports()` instead of widening it.

Not to be confused with `../engines/capabilityMcp.ts` and
`../engines/capabilityStdio.ts` — those host the kernel's *own* capability tools
**as** an MCP server, for engines that consume tools that way (Claude Code,
codex). This file is the opposite direction: consuming someone else's server.
