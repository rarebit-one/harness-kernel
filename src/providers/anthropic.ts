import Anthropic from "@anthropic-ai/sdk"
import type { TokenUsage } from "../models/types.js"
import { maxTokens, providerMaxRetries, providerTimeoutMs } from "./clientOptions.js"
import {
  rejectOption,
  resolveMaxRetries,
  resolveMaxTokens,
  resolvePromptCache,
  type CacheTtl,
  type ResolvedPromptCache,
  type ToolChoice,
} from "./options.js"
import type {
  AgentMessage,
  CompletionRequest,
  ConverseOptions,
  ConverseRequest,
  ConverseResult,
  FinishReason,
  Provider,
  ToolCall,
} from "./types.js"

/** The breakpoint marker placed on a block, with the requested lifetime. */
function cacheControl(ttl: CacheTtl | undefined): Anthropic.CacheControlEphemeral {
  return { type: "ephemeral", ...(ttl !== undefined ? { ttl } : {}) }
}

/** Where to put message breakpoints: how many trailing messages, and the lifetime. */
export interface AnthropicMessageCache {
  trailingMessages: number
  ttl?: CacheTtl
}

/**
 * Map provider-neutral messages to Anthropic's message params (pure; tested).
 *
 * With `cache` set, the last content block of each of the trailing N messages
 * carries a `cache_control` breakpoint, so the whole prefix up to and including
 * that message is served from cache on the next call. Messages outside the
 * trailing window keep the compact string form a plain user turn had before
 * caching existed.
 */
export function toAnthropicMessages(
  messages: AgentMessage[],
  cache?: AnthropicMessageCache,
): Anthropic.MessageParam[] {
  const firstCached = cache ? Math.max(0, messages.length - cache.trailingMessages) : Infinity
  return messages.map((m, index): Anthropic.MessageParam => {
    const mark = cache !== undefined && index >= firstCached
    if (m.role === "user") {
      if (!mark) return { role: "user", content: m.text }
      return {
        role: "user",
        content: [{ type: "text", text: m.text, cache_control: cacheControl(cache.ttl) }],
      }
    }
    if (m.role === "assistant") {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []
      if (m.text) blocks.push({ type: "text", text: m.text })
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
      }
      if (mark) markLast(blocks, cache.ttl)
      return { role: "assistant", content: blocks }
    }
    // Tool results are sent back as a user turn of tool_result blocks.
    const blocks: Anthropic.ToolResultBlockParam[] = m.results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: r.content,
      is_error: r.isError ?? false,
    }))
    if (mark) markLast(blocks, cache.ttl)
    return { role: "user", content: blocks }
  })
}

/** Attach a breakpoint to the last block, when there is one to attach it to. */
function markLast(
  blocks: Array<{ cache_control?: Anthropic.CacheControlEphemeral | null }>,
  ttl: CacheTtl | undefined,
): void {
  const last = blocks[blocks.length - 1]
  if (last) last.cache_control = cacheControl(ttl)
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

/** Map Anthropic's `stop_reason` onto the neutral vocabulary (pure; tested). */
export function anthropicFinishReason(
  stopReason: Anthropic.StopReason | null | undefined,
): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop"
    case "tool_use":
      return "tool_calls"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length"
    case "refusal":
      return "content_filter"
    default:
      return "unknown"
  }
}

/** Anthropic's `tool_choice` for a neutral {@link ToolChoice}. */
function anthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  if (choice === "auto") return { type: "auto" }
  if (choice === "required") return { type: "any" }
  if (choice === "none") return { type: "none" }
  return { type: "tool", name: choice.name }
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

/**
 * Build the Messages API request for one conversation step (pure; tested).
 *
 * Prompt caching places up to four breakpoints: the system prompt (sent as one
 * text block so it can carry one), the last tool definition, and the trailing
 * messages. A `responseFormat` or an `openrouter` block is rejected here: the
 * Messages API has neither, and honouring a structured answer means a terminal
 * tool with a schema, not a request flag.
 */
export function anthropicRequestBody(
  model: string,
  req: ConverseRequest,
  fallbackMaxTokens: number = maxTokens(),
): Anthropic.MessageCreateParamsNonStreaming {
  const options = req.providerOptions
  rejectOption("anthropic", options, "responseFormat", "use a terminal tool with a schema")
  rejectOption("anthropic", options, "openrouter")
  const cache: ResolvedPromptCache | undefined = options?.promptCache
    ? resolvePromptCache(options.promptCache)
    : undefined

  const tools: Anthropic.Tool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))
  if (cache?.tools) {
    const last = tools[tools.length - 1]
    if (last) last.cache_control = cacheControl(cache.ttl)
  }

  // An empty system prompt stays a string: Anthropic rejects an empty text block.
  const system: Anthropic.MessageCreateParams["system"] =
    cache?.system && req.system
      ? [{ type: "text", text: req.system, cache_control: cacheControl(cache.ttl) }]
      : req.system

  return {
    model,
    max_tokens: resolveMaxTokens(options, fallbackMaxTokens),
    ...(typeof options?.temperature === "number" ? { temperature: options.temperature } : {}),
    // Omitted on a tools-free request: the budget summary call sends the same
    // options with no tools, and a forced choice there is an API error.
    ...(options?.toolChoice !== undefined && tools.length > 0
      ? { tool_choice: anthropicToolChoice(options.toolChoice) }
      : {}),
    system,
    tools,
    messages: toAnthropicMessages(
      req.messages,
      cache && cache.trailingMessages > 0
        ? { trailingMessages: cache.trailingMessages, ...(cache.ttl ? { ttl: cache.ttl } : {}) }
        : undefined,
    ),
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic"
  readonly reportsUsage = true
  readonly model: string
  private client: Anthropic

  constructor(
    apiKey: string,
    model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    /** Where requests go instead of the SDK's default (a credential gateway, a proxy). */
    baseURL?: string,
  ) {
    // The SDK retries transient 429/5xx/network errors with exponential backoff
    // internally, so a blip doesn't fail the whole run; `timeout` bounds each
    // request. Both are env-overridable.
    this.client = new Anthropic({
      apiKey,
      timeout: providerTimeoutMs(),
      maxRetries: providerMaxRetries(),
      ...(baseURL !== undefined ? { baseURL } : {}),
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
    // Per-request options, so an abort cancels THIS call (retries included)
    // and a per-call retry count leaves the shared client untouched.
    const retries = resolveMaxRetries(req.providerOptions)
    const message = await this.client.messages.create(anthropicRequestBody(this.model, req), {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(retries !== undefined ? { maxRetries: retries } : {}),
    })

    const usage = anthropicUsage(message.usage)
    return {
      ...parseAnthropicContent(message.content),
      ...(usage ? { usage } : {}),
      finishReason: anthropicFinishReason(message.stop_reason),
      ...(typeof message.model === "string" && message.model ? { model: message.model } : {}),
      ...(typeof message.id === "string" && message.id ? { responseId: message.id } : {}),
    }
  }
}
