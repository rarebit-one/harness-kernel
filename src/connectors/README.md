# Connectors

`mcpClient.ts` is the kernel's MCP **client** — it connects to external MCP
servers (described by a `ConnectorConfig`) over `stdio`, `streamable_http`, or
`sse`, and exposes `listTools()` / `callTool()`.

The caller owns the connector lifecycle: it stores connector records, runs any
OAuth flow, and resolves a **fresh bearer token** into `ConnectorConfig.auth.token`
before each run. The kernel treats tokens as opaque and only attaches them (as a
request header for HTTP transports, or an env var for stdio).

When the credential expires before the run ends (a short-lived token minted by a
credential service), set `auth.headers` instead of `auth.token`: a function,
async allowed, that returns the headers for one request. It is asked before
every request the HTTP transports make (the initialize, each tool call, the
event stream), so a rotated credential is used from the next request on; cache
inside it if minting is costly. When the server answers 401 it is asked again
with `refresh: true` and that request is sent once more; a second 401 fails as
usual. Refresh beyond that one retry is the caller's job.

- A throw, or a return that is not a map of valid string header values, fails
  the request with `connector <name>: auth headers …`. The function's own error
  is the `cause`, never the message, because it can quote the credential; a
  value fetch rejects (a line break, a NUL) is named by header only. At connect
  time that fails the run; mid-run it fails that tool call.
- Return **only credential headers**. Every value is masked, so a non-secret
  such as `Accept: application/json` would turn into `[secret]` wherever it
  appears in tool output. Each distinct value joins the mask for the rest of
  the run, so a credential minted per request grows it request by request.
- Requests carrying these headers go out with `redirect: "manual"`: the
  transport follows a same-origin redirect and no other, so a credential
  header never reaches an origin the server points at.
- `connectMcp(config, { onSecret })` (and `connectorTools(..., { onSecret })`)
  hears every credential as it is sent: a static token, and each value the
  function returns plus the part after its scheme (`Bearer abc` also yields
  `abc`). The native engine feeds these into the run's secret mask, so a token
  rotated mid-run is masked in tool output like one the run started with.
- Setting both `token` and `headers` is refused, and so is `headers` on a
  stdio connector, whose token is fixed at spawn. The out-of-process engines
  refuse a run with `headers` in `supports()`, and writing such a connector
  into their server config throws; under `vm` isolation it counts as an
  exposed credential.

`clientInfo` (`{ name, version? }`) replaces the client identity announced to
the server; absent, it is `MCP_CLIENT_NAME` suffixed with the connector's name,
at version `0.1.0`.

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
