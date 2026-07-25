import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import type { CapabilityTool } from "./capability.js"

/**
 * The MCP server name the runner-hosted capability surface is registered under.
 * Tools are therefore reachable by the model as `mcp__jumpdrive__<tool>` — see
 * {@link capabilityToolIds}.
 */
export const CAPABILITY_SERVER_NAME = "jumpdrive"

/** Fully-qualified tool ids the Agent SDK exposes for a capability server. */
export function capabilityToolIds(tools: CapabilityTool[]): string[] {
  return tools.map((t) => `mcp__${CAPABILITY_SERVER_NAME}__${t.name}`)
}

/**
 * Wrap the transport-neutral {@link CapabilityTool}s in an in-process Anthropic
 * Agent SDK MCP server, so the Claude Code engine gets the exact same
 * workspace-scoped authority the native engine has — no separate process, no
 * network. The SDK is imported lazily (this module is only reached from the
 * Claude Code driver, which never runs on the warm shared runner).
 *
 * The capability handler is the security boundary; this adapter only marshals
 * the SDK's parsed args into it and JSON-encodes the result back to the model.
 */
export async function capabilitySdkServer(
  tools: CapabilityTool[],
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk")
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
