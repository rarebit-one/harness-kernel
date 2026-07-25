import type { McpServerConfig, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeCodeMessage, ClaudeCodeOptions } from "./claudeCode.js"
import { CAPABILITY_SERVER_NAME, capabilitySdkServer, capabilityToolIds } from "./capabilityMcp.js"
import { connectorServers } from "./connectorMcp.js"

/**
 * The default Claude Code driver: runs the Anthropic Agent SDK's `query()` (which
 * spawns the Claude Code CLI) against the prepared workdir and normalizes its
 * message stream. This is the ONLY module that touches the SDK, and it loads it
 * lazily (dynamic import) so the warm runner — where this engine never runs —
 * doesn't pay to import it.
 *
 * Permission mode is `bypassPermissions`: this engine only runs inside a throwaway
 * ephemeral container (enforced by ClaudeCodeEngine.supports), so the container,
 * not an interactive human, is the safety boundary.
 */
export async function* defaultClaudeCodeDriver(
  opts: ClaudeCodeOptions,
): AsyncIterable<ClaudeCodeMessage> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")

  const controller = new AbortController()
  const timer =
    opts.maxDurationMs && opts.maxDurationMs > 0
      ? setTimeout(() => controller.abort(), opts.maxDurationMs)
      : undefined

  // Mount the run's MCP servers: the runner-hosted, workspace-scoped capability
  // surface (in-process) so Claude Code emits issues/knowledge/files uniformly with
  // native, plus the run's external connectors (Slack, an Airwallex MCP, …) so they
  // become tools inside Claude Code too. Same connector source the native engine uses.
  const capabilities = opts.mcpTools ?? []
  const connectors = connectorServers(opts.connectors ?? [])
  const mcpServers: Record<string, McpServerConfig> = { ...connectors }
  if (capabilities.length > 0) {
    mcpServers[CAPABILITY_SERVER_NAME] = await capabilitySdkServer(capabilities)
  }
  const hasMcpServers = Object.keys(mcpServers).length > 0

  // When the workflow narrows tools (allowedTools set), the mounted MCP tools must
  // still be permitted; append the capability tool ids and a server-level allow for
  // each connector (whose tool names are only known at connect time). With no
  // allowlist, bypassPermissions already permits every tool.
  const allowedTools =
    opts.allowedTools && opts.allowedTools.length > 0
      ? [
          ...opts.allowedTools,
          ...capabilityToolIds(capabilities),
          ...Object.keys(connectors).map((name) => `mcp__${name}`),
        ]
      : opts.allowedTools

  const options: Options = {
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController: controller,
    env: { ...process.env, ...(opts.apiKey ? { ANTHROPIC_API_KEY: opts.apiKey } : {}) },
    ...(hasMcpServers ? { mcpServers } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  }

  try {
    for await (const message of query({ prompt: opts.prompt, options })) {
      const normalized = normalize(message)
      if (normalized) yield normalized
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalize(message: SDKMessage): ClaudeCodeMessage | undefined {
  if (message.type === "assistant") {
    const text = extractText(message.message.content)
    return text ? { kind: "assistant", text } : undefined
  }
  if (message.type === "result") {
    const text = message.subtype === "success" ? message.result : ""
    return { kind: "result", text, isError: message.is_error }
  }
  return undefined
}

/** Concatenate the text blocks of an assistant message's content. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      texts.push((block as { text: string }).text)
    }
  }
  return texts.join("\n")
}
