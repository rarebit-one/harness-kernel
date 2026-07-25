import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { ConnectorConfig } from "../types.js"

/**
 * A serializable MCP server config — the shape both the Anthropic Agent SDK's
 * `mcpServers` option (for its process-transport servers) and a `.mcp.json` file
 * (for codex / external-CLI engines) understand. The runner resolves connector
 * auth tokens control-plane side, so they are inlined here as the transport
 * expects (a bearer header for HTTP-family, `MCP_AUTH_TOKEN` env for stdio —
 * mirroring src/connectors/mcpClient.ts, the native engine's connector client).
 */
export type SerializableMcpServer =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }

function bearerHeaders(config: ConnectorConfig): Record<string, string> | undefined {
  if (config.auth?.type === "bearer" && config.auth.token) {
    return { Authorization: `Bearer ${config.auth.token}` }
  }
  return undefined
}

/**
 * Translate one connector into a serializable MCP server config, or null when it
 * isn't an MCP connector this seam can carry (a plain `http` service, or a
 * malformed config missing its endpoint/command). Same source data the native
 * engine's connector client consumes — one definition, every engine.
 */
export function connectorToMcpServer(config: ConnectorConfig): SerializableMcpServer | null {
  if (config.kind !== "mcp") return null

  switch (config.transport) {
    case "stdio": {
      if (!config.command) return null
      const env =
        config.auth?.type === "bearer" && config.auth.token
          ? { MCP_AUTH_TOKEN: config.auth.token }
          : undefined
      return {
        type: "stdio",
        command: config.command,
        ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
        ...(env ? { env } : {}),
      }
    }
    case "streamable_http": {
      if (!config.endpoint) return null
      const headers = bearerHeaders(config)
      return { type: "http", url: config.endpoint, ...(headers ? { headers } : {}) }
    }
    case "sse": {
      if (!config.endpoint) return null
      const headers = bearerHeaders(config)
      return { type: "sse", url: config.endpoint, ...(headers ? { headers } : {}) }
    }
    default:
      return null
  }
}

/**
 * Build the `<name> → server config` map for a run's MCP connectors, skipping any
 * that don't translate. Suitable both for the Agent SDK's `mcpServers` option and
 * for a `.mcp.json` file's `mcpServers` field.
 */
export function connectorServers(
  connectors: ConnectorConfig[],
): Record<string, SerializableMcpServer> {
  const servers: Record<string, SerializableMcpServer> = {}
  for (const config of connectors) {
    const server = connectorToMcpServer(config)
    if (server) servers[config.name] = server
  }
  return servers
}

/**
 * Write a `.mcp.json` at the sandbox root — the shape a generic CLI harness that
 * follows the Claude Code convention reads. No-op when there are no servers.
 * Returns the servers written (for logging / assertions).
 *
 * NOTE: the OpenAI Codex CLI does NOT read `.mcp.json` — it discovers MCP servers
 * from `$CODEX_HOME/config.toml` under `[mcp_servers.<name>]`. The codex engine
 * uses {@link writeCodexConfig} instead; this seam is kept for any generic-CLI use.
 */
export async function writeMcpJson(
  workdir: string,
  servers: Record<string, SerializableMcpServer>,
): Promise<Record<string, SerializableMcpServer>> {
  if (Object.keys(servers).length === 0) return servers
  const file = path.join(workdir, ".mcp.json")
  await writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  return servers
}

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
  return `"${escaped}"`
}

/** Serialize a `{ KEY: "value" }` map as a TOML inline table with quoted keys. */
function tomlInlineTable(map: Record<string, string>): string {
  const pairs = Object.entries(map).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
  return `{ ${pairs.join(", ")} }`
}

/** Render one MCP server as a `[mcp_servers."<name>"]` TOML section. */
function codexServerSection(name: string, server: SerializableMcpServer): string {
  const lines = [`[mcp_servers.${tomlString(name)}]`]
  if (server.type === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`)
    if (server.args && server.args.length > 0) {
      lines.push(`args = [${server.args.map(tomlString).join(", ")}]`)
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${tomlInlineTable(server.env)}`)
    }
  } else {
    // Codex speaks Streamable HTTP over `url`; it has no distinct SSE transport, so
    // an `sse` connector is carried the same way (a legacy SSE-only endpoint may not
    // work). Resolved bearer tokens ride inline in `http_headers` (Authorization),
    // which is exactly why the config file must be written pre-run and deleted after.
    lines.push(`url = ${tomlString(server.url)}`)
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`http_headers = ${tomlInlineTable(server.headers)}`)
    }
  }
  return lines.join("\n")
}

/**
 * Write a `config.toml` into a codex home directory so the OpenAI Codex CLI (run
 * with `CODEX_HOME` pointed here) discovers the run's MCP servers — the run's
 * connectors plus the runner-hosted capability server — as `[mcp_servers.<name>]`
 * tables. This is codex's REAL discovery mechanism (it ignores `.mcp.json`).
 *
 * The file can carry resolved connector auth tokens (inline `http_headers`, or a
 * stdio server's `MCP_AUTH_TOKEN` env), so callers MUST write it to a transient
 * location outside the sandbox tree and delete it after the run — never let it
 * reach the change set. No-op when there are no servers. Returns the path written
 * (or null when nothing was written), for logging / assertions.
 */
export async function writeCodexConfig(
  codexHome: string,
  servers: Record<string, SerializableMcpServer>,
): Promise<string | null> {
  if (Object.keys(servers).length === 0) return null
  const sections = Object.entries(servers).map(([name, server]) => codexServerSection(name, server))
  const file = path.join(codexHome, "config.toml")
  await writeFile(file, `${sections.join("\n\n")}\n`)
  return file
}
