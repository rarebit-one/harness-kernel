import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ConnectorConfig } from "../types.js"

// NOTE: these connector modules are not yet wired into the agentic run loop in
// runner.ts — that integration is a deliberate follow-up. For now they are
// standalone, tested building blocks.

/** A live MCP connection, narrowed to what the runner needs. */
export interface McpConnection {
  listTools(): Promise<unknown>
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

/** Bearer auth is attached as a request header for the HTTP-family transports. */
function bearerInit(config: ConnectorConfig): { requestInit?: RequestInit } {
  if (config.auth?.type === "bearer" && config.auth.token) {
    return { requestInit: { headers: { Authorization: `Bearer ${config.auth.token}` } } }
  }
  return {}
}

function buildTransport(config: ConnectorConfig): Transport {
  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new Error(`connector ${config.name}: stdio transport requires a command`)
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
      return new StreamableHTTPClientTransport(new URL(config.endpoint), bearerInit(config))
    }
    case "sse": {
      if (!config.endpoint) {
        throw new Error(`connector ${config.name}: sse transport requires an endpoint`)
      }
      return new SSEClientTransport(new URL(config.endpoint), bearerInit(config))
    }
    default:
      throw new Error(`connector ${config.name}: unknown transport ${String(config.transport)}`)
  }
}

/** Connect to an MCP connector using the transport implied by its config. */
export async function connectMcp(config: ConnectorConfig): Promise<McpConnection> {
  return connectWithTransport(config.name, buildTransport(config))
}

/**
 * Connect over an arbitrary transport. Exposed so tests (and future callers) can
 * supply an in-memory transport pair without spawning a process or hitting the
 * network.
 */
export async function connectWithTransport(
  name: string,
  transport: Transport,
): Promise<McpConnection> {
  const client = new Client({ name: `jumpdrive-web-runner/${name}`, version: "0.1.0" })
  await client.connect(transport)

  return {
    listTools: () => client.listTools(),
    callTool: (toolName, args = {}) => client.callTool({ name: toolName, arguments: args }),
    close: () => client.close(),
  }
}
