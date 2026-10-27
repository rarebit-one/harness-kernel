import type { McpServerConfig, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { runStop, type StoppedBy } from "../signals.js"
import type { ClaudeCodeMessage, ClaudeCodeOptions } from "./claudeCode.js"
import { CAPABILITY_SERVER_NAME, capabilitySdkServer, capabilityToolIds } from "./capabilityMcp.js"
import { connectorServers } from "./connectorMcp.js"
import { childEnv } from "./isolation.js"

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

  // The SDK takes an AbortController, so the merged stop signal (own timer +
  // the caller's cancel) drives one. `stop.stoppedBy()` says which fired.
  const controller = new AbortController()
  const stop = runStop(opts.maxDurationMs, opts.signal)
  const onStop = (): void => controller.abort(stop.signal?.reason)
  if (stop.signal?.aborted) onStop()
  else stop.signal?.addEventListener("abort", onStop, { once: true })

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
    env: claudeCodeEnv(opts),
    ...(hasMcpServers ? { mcpServers } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...environmentSdkOptions(opts),
  }

  // The stream's last result: a stop after a clean one must not relabel a run
  // that had already finished, and one after an error result keeps its text.
  let lastResult: ResultMessage | undefined
  try {
    for await (const message of query({ prompt: opts.prompt, options })) {
      const normalized = normalize(message)
      if (normalized?.kind === "result") lastResult = normalized
      if (normalized) yield normalized
    }
  } catch (err) {
    if (!stop.stoppedBy()) throw err
  } finally {
    stop.signal?.removeEventListener("abort", onStop)
  }
  // An abort ends the SDK's stream with an error (or an error result), not a
  // clean result; report a result that says who stopped it, so the engine can
  // map the outcome.
  const stopped = stopResult(lastResult, stop.stoppedBy())
  if (stopped) yield stopped
}

/**
 * The SDK options a run's environment adds: an appended system prompt, the
 * settings sources, and the skills plugin. Empty when the engine set none of
 * them, so a run without an environment builds exactly the options it always
 * did.
 */
export function environmentSdkOptions(
  opts: Pick<ClaudeCodeOptions, "systemPromptAppend" | "settingSources" | "pluginDirs">,
): Pick<Options, "systemPrompt" | "settingSources" | "plugins"> {
  return {
    ...(opts.systemPromptAppend
      ? {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: opts.systemPromptAppend,
          },
        }
      : {}),
    ...(opts.settingSources ? { settingSources: opts.settingSources } : {}),
    ...(opts.pluginDirs && opts.pluginDirs.length > 0
      ? { plugins: opts.pluginDirs.map((dir) => ({ type: "local" as const, path: dir })) }
      : {}),
  }
}

/** Host env the Claude Code CLI may inherit: its own and its provider's settings. */
const CLAUDE_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const

/**
 * The CLI's environment: an allowlist, never the host's whole one. The CLI runs
 * arbitrary bash, so anything the host process holds (its own credentials,
 * callback tokens) would otherwise be one `env` away from the model. Cloud
 * back ends that read `AWS_*`/`GOOGLE_*` (Bedrock, Vertex) are not reached
 * through this engine.
 */
export function claudeCodeEnv(
  opts: Pick<ClaudeCodeOptions, "apiKey">,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return childEnv(CLAUDE_ENV_PREFIXES, opts.apiKey ? { ANTHROPIC_API_KEY: opts.apiKey } : {}, env)
}

type ResultMessage = Extract<ClaudeCodeMessage, { kind: "result" }>

/**
 * The result to report after a stop, or `undefined` when there is nothing to
 * add: no stop happened, or the harness had already finished cleanly. After an
 * error result the harness's own text is carried over rather than blanked.
 */
export function stopResult(
  last: ResultMessage | undefined,
  stoppedBy: StoppedBy | undefined,
): ResultMessage | undefined {
  if (!stoppedBy || (last && !last.isError)) return undefined
  return { kind: "result", text: last?.text ?? "", isError: true, stoppedBy }
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
