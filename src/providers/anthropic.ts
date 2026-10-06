import Anthropic from "@anthropic-ai/sdk"
import type { TokenUsage } from "../models/types.js"
import { maxTokens, providerMaxRetries, providerTimeoutMs } from "./clientOptions.js"
import type {
  AgentMessage,
  CompletionRequest,
  ConverseOptions,
  ConverseRequest,
  ConverseResult,
  Provider,
  ToolCall,
} from "./types.js"

/** Map provider-neutral messages to Anthropic's message params (pure; tested). */
export function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      return { role: "user", content: m.text }
    }
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.text) blocks.push({ type: "text", text: m.text })
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
      }
      return { role: "assistant", content: blocks }
    }
    // Tool results are sent back as a user turn of tool_result blocks.
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
        is_error: r.isError ?? false,
      })),
    }
  })
}

/** Reduce an Anthropic response's content blocks to text + tool calls (pure; tested). */
export function parseAnthropicContent(content: Anthropic.ContentBlock[]): ConverseResult {
  let text = ""
  const toolCalls: ToolCall[] = []
  for (const block of content) {
    if (block.type === "text") {
      text += text ? `\n${block.text}` : block.text
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      })
    }
  }
  return { text, toolCalls }
}

/**
 * Map an Anthropic `usage` block to the kernel's token accounting (pure; tested).
 *
 * Anthropic's `input_tokens` counts only UNCACHED input; cache reads and cache
 * writes are reported separately. Total input is the sum of all three, so that
 * is what `inputTokens` carries, with the cache split out alongside.
 */
export function anthropicUsage(
  usage:
    | Pick<
        Anthropic.Usage,
        "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
      >
    | Pick<Anthropic.Usage, "input_tokens" | "output_tokens">
    | null
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined
  const cacheRead = "cache_read_input_tokens" in usage ? (usage.cache_read_input_tokens ?? 0) : 0
  const cacheWrite =
    "cache_creation_input_tokens" in usage ? (usage.cache_creation_input_tokens ?? 0) : 0
  const inputTokens = usage.input_tokens + cacheRead + cacheWrite
  const outputTokens = usage.output_tokens
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic"
  readonly reportsUsage = true
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6") {
    // The SDK retries transient 429/5xx/network errors with exponential backoff
    // internally, so a blip doesn't fail the whole run; `timeout` bounds each
    // request. Both are env-overridable.
    this.client = new Anthropic({
      apiKey,
      timeout: providerTimeoutMs(),
      maxRetries: providerMaxRetries(),
    })
    this.model = model
  }

  async complete(req: CompletionRequest): Promise<string> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens(),
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    })

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }

  async converse(req: ConverseRequest, opts?: ConverseOptions): Promise<ConverseResult> {
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: maxTokens(),
        system: req.system,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages: toAnthropicMessages(req.messages),
      },
      // Per-request, so an abort cancels THIS call (retries included) and
      // leaves the shared client untouched.
      opts?.signal ? { signal: opts.signal } : undefined,
    )

    const usage = anthropicUsage(message.usage)
    return { ...parseAnthropicContent(message.content), ...(usage ? { usage } : {}) }
  }
}
