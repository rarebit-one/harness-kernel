import { loadAgentSdk } from "./agentSdk.js"
import type { CapabilityTool } from "./capability.js"

/**
 * The MCP server name the kernel-hosted capability surface is registered under.
 * Tools are therefore reachable by the model as `mcp__workspace__<tool>` — see
 * {@link capabilityToolIds}. It names what the authority is scoped to (the run's
 * workspace), not who is hosting it.
 */
export const CAPABILITY_SERVER_NAME = "workspace"

/** Fully-qualified tool ids the Agent SDK exposes for a capability server. */
export function capabilityToolIds(tools: CapabilityTool[]): string[] {
  return tools.map((t) => `mcp__${CAPABILITY_SERVER_NAME}__${t.name}`)
}

/**
 * The in-process server config the Agent SDK hands back, described structurally:
 * this module is part of the public surface, and its declarations must not
 * require the SDK, which is an optional peer. `instance` is the SDK's server.
 */
export interface CapabilitySdkServerConfig {
  type: "sdk"
  name: string
  instance: unknown
}

/**
 * Wrap the transport-neutral {@link CapabilityTool}s in an in-process Anthropic
 * Agent SDK MCP server, so the Claude Code engine gets the exact same
 * workspace-scoped authority the native engine has — no separate process, no
 * network. The SDK is an optional peer, imported lazily (this is only reached
 * from the Claude Code driver, which never runs on a warm shared host); calling
 * it without the SDK installed throws `AgentSdkMissingError`.
 *
 * The capability handler is the security boundary; this adapter only marshals
 * the SDK's parsed args into it and JSON-encodes the result back to the model.
 */
export async function capabilitySdkServer(
  tools: CapabilityTool[],
): Promise<CapabilitySdkServerConfig> {
  const { createSdkMcpServer, tool } = await loadAgentSdk()
  return createSdkMcpServer({
    name: CAPABILITY_SERVER_NAME,
    version: "0.1.0",
    tools: tools.map((cap) =>
      tool(cap.name, cap.description, cap.schema, async (args) => {
        const result = await cap.handler(args)
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          ...(result.ok ? {} : { isError: true }),
        }
      }),
    ),
  })
}
