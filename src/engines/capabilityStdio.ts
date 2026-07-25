import { pathToFileURL } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { capabilityTools, type CapabilityContext } from "./capability.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"
import { writeEmissions, type Emissions } from "./capabilityEmissions.js"

/**
 * The runner-hosted capability surface, hosted as a standalone MCP server over an
 * arbitrary transport — for engines that run as an EXTERNAL process (codex / a
 * CLI) and reach the runner's authority through a configured stdio MCP server
 * (codex's `config.toml`) rather than an in-process SDK server. It is the exact
 * same {@link capabilityTools}
 * surface, so the workspace-scope and privileged-op guarantees are identical; the
 * only difference is emit delivery: open_issue / promote_knowledge are persisted
 * to an emissions file (read back by the engine after the run), while write_file
 * lands in the sandbox as usual.
 */
export interface CapabilityStdioConfig {
  workspaceId: string
  workdir: string
  /** Absolute path (OUTSIDE the sandbox) where issue/knowledge emissions are persisted. */
  emissionsFile: string
}

/** Build the capability MCP server for external-process hosting (not yet connected). */
export function buildCapabilityStdioServer(config: CapabilityStdioConfig): McpServer {
  const emissions: Emissions = { issues: [], knowledge: [] }
  const ctx: CapabilityContext = {
    workspaceId: config.workspaceId,
    workdir: config.workdir,
    issues: emissions.issues,
    knowledge: emissions.knowledge,
  }
  const server = new McpServer({ name: CAPABILITY_SERVER_NAME, version: "0.1.0" })

  for (const cap of capabilityTools(ctx)) {
    server.registerTool(
      cap.name,
      { description: cap.description, inputSchema: cap.schema },
      async (args: Record<string, unknown>) => {
        const result = await cap.handler(args)
        // Persist the full accumulated state so the runner can read it after the
        // external engine process exits (write_file already landed on disk).
        await writeEmissions(config.emissionsFile, emissions)
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
  config: CapabilityStdioConfig,
  transport: Transport = new StdioServerTransport(),
): Promise<McpServer> {
  const server = buildCapabilityStdioServer(config)
  await server.connect(transport)
  return server
}

/** Read the stdio server's config from the environment the runner sets on spawn. */
export function capabilityStdioConfigFromEnv(): CapabilityStdioConfig {
  const workspaceId = process.env.HARNESS_WORKSPACE_ID
  const workdir = process.env.HARNESS_WORKDIR
  const emissionsFile = process.env.HARNESS_EMISSIONS_FILE
  if (!workspaceId || !workdir || !emissionsFile) {
    throw new Error("HARNESS_WORKSPACE_ID, HARNESS_WORKDIR and HARNESS_EMISSIONS_FILE are required")
  }
  return { workspaceId, workdir, emissionsFile }
}

// Bin entrypoint: an external engine (codex) spawns this module as its MCP server
// via the stdio entry in the `config.toml` the codex engine writes. Kept
// side-effect-free on import so
// the other engines can import the builders above without starting a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveCapability(capabilityStdioConfigFromEnv()).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[capability-server] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
