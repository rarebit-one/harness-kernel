import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CapabilityTool } from "./capability.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"

/**
 * Hosts a capability surface as a standalone MCP server over an arbitrary
 * transport — for engines that run as an EXTERNAL process (codex, or any CLI)
 * and reach the run's authority through a configured stdio MCP server rather
 * than an in-process SDK server.
 *
 * This is the generic mechanism only. It does not know which capabilities it is
 * serving or what a call means: the tools are handed in, and `afterCall` is the
 * hook an application uses to persist whatever the call accumulated, since a
 * child process cannot share memory with the run that spawned it.
 *
 * Because the tool set is injected, the application owns the entrypoint script
 * that the external engine spawns — a child process cannot be handed a closure.
 * Build the server there and connect it with {@link serveCapability}.
 */
export interface CapabilityStdioOptions {
  /** The capabilities to expose. Order is preserved in the advertised list. */
  tools: CapabilityTool[]
  /**
   * Run after every handler call, successful or not. The usual job is to flush
   * accumulated state to a file outside the sandbox so the spawning process can
   * read it once the child exits.
   */
  afterCall?: () => Promise<void>
}

/** The spawn contract an external engine fills in via the environment. */
export interface CapabilityStdioConfig {
  workspaceId: string
  workdir: string
  /** Absolute path (OUTSIDE the sandbox) where a run's emissions are persisted. */
  emissionsFile: string
}

/** Build the capability MCP server for external-process hosting (not yet connected). */
export function buildCapabilityStdioServer(options: CapabilityStdioOptions): McpServer {
  const server = new McpServer({ name: CAPABILITY_SERVER_NAME, version: "0.1.0" })

  for (const cap of options.tools) {
    server.registerTool(
      cap.name,
      { description: cap.description, inputSchema: cap.schema },
      async (args: Record<string, unknown>) => {
        const result = await cap.handler(args)
        await options.afterCall?.()
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(result.ok ? {} : { isError: true }),
        }
      },
    )
  }
  return server
}

/** Connect a built capability server over the given transport (stdio in production). */
export async function serveCapability(
  options: CapabilityStdioOptions,
  transport: Transport = new StdioServerTransport(),
): Promise<McpServer> {
  const server = buildCapabilityStdioServer(options)
  await server.connect(transport)
  return server
}

/**
 * Read the spawn contract from the environment the spawning engine sets. The
 * variable names are part of that contract — see the codex engine, which writes
 * them into the config it hands the external process.
 */
export function capabilityStdioConfigFromEnv(): CapabilityStdioConfig {
  const workspaceId = process.env.HARNESS_WORKSPACE_ID
  const workdir = process.env.HARNESS_WORKDIR
  const emissionsFile = process.env.HARNESS_EMISSIONS_FILE
  if (!workspaceId || !workdir || !emissionsFile) {
    throw new Error("HARNESS_WORKSPACE_ID, HARNESS_WORKDIR and HARNESS_EMISSIONS_FILE are required")
  }
  return { workspaceId, workdir, emissionsFile }
}
