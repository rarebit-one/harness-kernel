import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ConnectorConfig } from "../types.js"
import { authHeadersFetch } from "./auth.js"

/**
 * The default client identity announced to an MCP server, suffixed with the
 * connector's own name; `ConnectorConfig.clientInfo` replaces it. Servers use
 * it for logging and telemetry.
 */
export const MCP_CLIENT_NAME = "harness-kernel"

/** Options for {@link connectMcp}. */
export interface ConnectMcpOptions {
  /**
   * Called with each credential the connection sends (a static token, or every
   * value an `auth.headers` function returns, as it returns it), so the caller
   * can mask it in what the run's tools hand back.
   */
  onSecret?: (value: string) => void
}

/** Per-call options for {@link McpConnection.callTool}. */
export interface McpCallOptions {
  /** Aborts the request; the SDK notifies the server that the call was cancelled. */
  signal?: AbortSignal
}

/** A live MCP connection, narrowed to what the tool registry needs. */
export interface McpConnection {
  listTools(): Promise<unknown>
  callTool(name: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<unknown>
  close(): Promise<void>
}

/**
 * Auth for the HTTP-family transports: a static bearer rides as a request
 * header; an `auth.headers` function is asked for every request instead.
 */
function httpAuth(
  config: ConnectorConfig,
  onSecret: (value: string) => void,
): { requestInit?: RequestInit; fetch?: FetchLike } {
  if (config.auth?.headers) {
    return { fetch: authHeadersFetch(config.name, config.auth.headers, onSecret) }
  }
  if (config.auth?.type === "bearer" && config.auth.token) {
    return { requestInit: { headers: { Authorization: `Bearer ${config.auth.token}` } } }
  }
  return {}
}

function buildTransport(config: ConnectorConfig, onSecret: (value: string) => void): Transport {
  if (config.auth?.headers && config.auth.token) {
    throw new Error(`connector ${config.name}: set auth.token or auth.headers, not both`)
  }
  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new Error(`connector ${config.name}: stdio transport requires a command`)
      }
      if (config.auth?.headers) {
        throw new Error(
          `connector ${config.name}: stdio transport takes no auth.headers; resolve the token into auth.token`,
        )
      }
      // stdio servers receive credentials via env, not headers.
      const env =
        config.auth?.type === "bearer" && config.auth.token
          ? { ...getDefaultEnvironment(), MCP_AUTH_TOKEN: config.auth.token }
          : undefined
      return new StdioClientTransport({ command: config.command, args: config.args ?? [], env })
    }
    case "streamable_http": {
      if (!config.endpoint) {
        throw new Error(`connector ${config.name}: streamable_http transport requires an endpoint`)
      }
      return new StreamableHTTPClientTransport(new URL(config.endpoint), httpAuth(config, onSecret))
    }
    case "sse": {
      if (!config.endpoint) {
        throw new Error(`connector ${config.name}: sse transport requires an endpoint`)
      }
      return new SSEClientTransport(new URL(config.endpoint), httpAuth(config, onSecret))
    }
    default:
      throw new Error(`connector ${config.name}: unknown transport ${String(config.transport)}`)
  }
}

/** Connect to an MCP connector using the transport implied by its config. */
export async function connectMcp(
  config: ConnectorConfig,
  opts: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const onSecret = opts.onSecret ?? (() => {})
  if (config.auth?.type === "bearer" && config.auth.token) {
    onSecret(config.auth.token)
  }
  return connectWithTransport(config.name, buildTransport(config, onSecret), config.clientInfo)
}

/**
 * Connect over an arbitrary transport. Exposed so tests (and future callers) can
 * supply an in-memory transport pair without spawning a process or hitting the
 * network.
 */
export async function connectWithTransport(
  name: string,
  transport: Transport,
  clientInfo?: ConnectorConfig["clientInfo"],
): Promise<McpConnection> {
  const client = new Client({
    name: clientInfo?.name ?? `${MCP_CLIENT_NAME}/${name}`,
    version: clientInfo?.version ?? "0.1.0",
  })
  await client.connect(transport)

  return {
    listTools: () => client.listTools(),
    callTool: (toolName, args = {}, opts) =>
      client.callTool(
        { name: toolName, arguments: args },
        undefined,
        opts?.signal ? { signal: opts.signal } : undefined,
      ),
    close: () => client.close(),
  }
}
