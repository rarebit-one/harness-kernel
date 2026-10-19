import OpenAI from "openai"
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

/**
 * A text content part that may carry an OpenRouter-style cache breakpoint. The
 * OpenAI SDK's own part type has no `cache_control`; OpenRouter accepts it and
 * forwards it to upstreams that cache (Anthropic, Gemini). It is typed here
 * rather than cast at the call site so the shape is visible.
 */
type CacheableTextPart = OpenAI.Chat.Completions.ChatCompletionContentPartText & {
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl }
}

function cachedPart(text: string, ttl: CacheTtl | undefined): CacheableTextPart {
  return { type: "text", text, cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } }
}

/** Where to put message breakpoints: how many trailing messages, and the lifetime. */
export interface OpenAIMessageCache {
  trailingMessages: number
  ttl?: CacheTtl
}

/**
 * Map provider-neutral messages to OpenAI chat messages (pure; tested).
 *
 * With `cache` set (OpenRouter), the trailing N messages are sent as content
 * parts with a `cache_control` breakpoint on their text. An assistant message
 * with no prose has nowhere to put one and is left as it was; a tool message
 * puts it on its last result. Messages outside the window keep the plain
 * string form.
 */
export function toOpenAIMessages(
  messages: AgentMessage[],
  cache?: OpenAIMessageCache,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  const firstCached = cache ? Math.max(0, messages.length - cache.trailingMessages) : Infinity
  messages.forEach((m, index) => {
    const mark = cache !== undefined && index >= firstCached
    if (m.role === "user") {
      out.push({ role: "user", content: mark ? [cachedPart(m.text, cache.ttl)] : m.text })
    } else if (m.role === "assistant") {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: mark && m.text ? [cachedPart(m.text, cache.ttl)] : m.text,
      }
      if (m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          // The model's own bytes when we have them, so a replayed call is
          // verbatim; the parsed object re-serialised otherwise.
          function: { name: tc.name, arguments: tc.argumentsText ?? JSON.stringify(tc.input) },
        }))
      }
      out.push(msg)
    } else {
      // Each tool result becomes its own `tool` message keyed by the call id;
      // the breakpoint goes on the last one so the whole batch sits inside it.
      m.results.forEach((r, i) => {
        const last = i === m.results.length - 1
        out.push({
          role: "tool",
          tool_call_id: r.toolCallId,
          content: mark && last ? [cachedPart(r.content, cache.ttl)] : r.content,
        })
      })
    }
  })
  return out
}

/** Reduce an OpenAI response message to text + tool calls (pure; tested). */
export function parseOpenAIMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ConverseResult {
  // Surface a refusal as text so a refused turn is distinguishable from a normal
  // empty-but-final one (otherwise the agent loop ends silently with no signal).
  const text = message.content ?? (message.refusal ? `Refused: ${message.refusal}` : "")
  const toolCalls: ToolCall[] = []
  for (const tc of message.tool_calls ?? []) {
    if (tc.type !== "function") continue
    toolCalls.push({
      id: tc.id,
      name: tc.function.name,
      input: parseArguments(tc.function.arguments),
      argumentsText: tc.function.arguments,
    })
  }
  return { text, toolCalls }
}

/** Map the OpenAI dialect's `finish_reason` onto the neutral vocabulary (pure; tested). */
export function openAIFinishReason(finishReason: string | null | undefined): FinishReason {
  switch (finishReason) {
    case "stop":
      return "stop"
    case "tool_calls":
    case "function_call":
      return "tool_calls"
    case "length":
      return "length"
    case "content_filter":
      return "content_filter"
    default:
      return "unknown"
  }
}

/** The dialect's `tool_choice` for a neutral {@link ToolChoice}. */
function openAIToolChoice(
  choice: ToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (typeof choice === "string") return choice
  return { type: "function", function: { name: choice.name } }
}

/**
 * The usage block as OpenRouter extends it: `cost` (credits, which OpenRouter
 * denominates in US dollars) and a cache-write count beside OpenAI's own
 * `cached_tokens` and `reasoning_tokens`. The SDK type knows none of the
 * extensions, so they are read through this widening rather than cast at each
 * site.
 */
type ExtendedUsage = OpenAI.Completions.CompletionUsage & {
  cost?: number
  prompt_tokens_details?: { cache_write_tokens?: number } | null
}

/**
 * Map an OpenAI-dialect `usage` block to the kernel's token accounting (pure;
 * tested). `prompt_tokens` already includes cached input, so it maps to
 * `inputTokens` as-is and `cached_tokens` is the cache-read breakdown. OpenAI
 * reports no write count; OpenRouter does (`cache_write_tokens`), and prices
 * the call (`cost`), so both are carried when present. Reasoning tokens are
 * the `completion_tokens_details` breakdown either side reports.
 */
export function openAIUsage(
  usage: OpenAI.Completions.CompletionUsage | null | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined
  const extended = usage as ExtendedUsage
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const written = extended.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0
  const cost = extended.cost
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost)
      ? { reportedCost: { amount: cost, currency: "USD" } }
      : {}),
  }
}

/** Parse a tool-call arguments JSON string, tolerating empty/invalid input. */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Constructor options for an OpenAI-compatible (chat.completions) provider. */
export interface OpenAICompatibleOptions {
  apiKey: string
  model: string
  /** Alternate chat.completions endpoint (e.g. OpenRouter); omit for api.openai.com. */
  baseURL?: string
  /**
   * Extra headers sent on every request (e.g. OpenRouter attribution). A `null`
   * value REMOVES a header the SDK would otherwise send — the local provider
   * uses `{ Authorization: null }` to make a keyless request carry no auth.
   */
  defaultHeaders?: Record<string, string | null>
}

/** The adapter names whose dialect differences this core knows about. */
export const OPENAI_ADAPTER = "openai"
export const OPENROUTER_ADAPTER = "openrouter"

/**
 * The chat.completions request body plus the fields OpenRouter adds to the
 * dialect (`models`, `provider`, `usage`, `transforms`). The SDK forwards
 * unknown body fields untouched, so they are typed here as an extension rather
 * than cast away at the call site.
 */
export type OpenAICompatibleBody =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    models?: string[]
    provider?: Record<string, unknown>
    usage?: { include: boolean }
    transforms?: string[]
  }

/**
 * Build the chat.completions request for one conversation step (pure; tested).
 *
 * `name` selects the dialect: `openrouter` accepts the `openrouter` options
 * block and places prompt-cache breakpoints as content parts; `openai` maps
 * `promptCache.key` onto `prompt_cache_key` (its caching is otherwise
 * automatic, so breakpoints have nothing to attach to); any other name (local
 * servers, custom endpoints) gets the plain dialect and rejects the
 * OpenRouter block.
 */
export function openAICompatibleRequestBody(
  name: string,
  model: string,
  req: ConverseRequest,
  fallbackMaxTokens: number = maxTokens(),
): OpenAICompatibleBody {
  const options = req.providerOptions
  const isOpenRouter = name === OPENROUTER_ADAPTER
  if (!isOpenRouter) rejectOption(name, options, "openrouter")
  const cache: ResolvedPromptCache | undefined = options?.promptCache
    ? resolvePromptCache(options.promptCache)
    : undefined
  const ttl = cache?.ttl

  const tools = req.tools.map((t): OpenAI.Chat.Completions.ChatCompletionTool => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))

  const system: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam =
    isOpenRouter && cache?.system && req.system
      ? { role: "system", content: [cachedPart(req.system, ttl)] }
      : { role: "system", content: req.system }
  const messageCache =
    isOpenRouter && cache && cache.trailingMessages > 0
      ? { trailingMessages: cache.trailingMessages, ...(ttl ? { ttl } : {}) }
      : undefined

  // OpenAI retired `max_tokens` in favour of `max_completion_tokens` (its
  // reasoning models reject the old name); OpenRouter and the local servers
  // document `max_tokens`, so each dialect gets the field it names.
  const cap = resolveMaxTokens(options, fallbackMaxTokens)
  const body: OpenAICompatibleBody = {
    model,
    ...(name === OPENAI_ADAPTER ? { max_completion_tokens: cap } : { max_tokens: cap }),
    messages: [system, ...toOpenAIMessages(req.messages, messageCache)],
    ...(tools.length > 0 ? { tools } : {}),
    // Omitted on a tools-free request: the budget summary call sends the same
    // options with no tools, and a forced choice there is an API error.
    ...(tools.length > 0 && options?.toolChoice !== undefined
      ? { tool_choice: openAIToolChoice(options.toolChoice) }
      : {}),
    ...(typeof options?.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
  }
  if (name === OPENAI_ADAPTER && cache?.key) body.prompt_cache_key = cache.key
  if (isOpenRouter && options?.openrouter) {
    const or = options.openrouter
    if (or.models) body.models = or.models
    if (or.provider) body.provider = { ...or.provider }
    if (or.usage) body.usage = or.usage
    if (or.transforms) body.transforms = or.transforms
  }
  return body
}

/**
 * Shared core for providers speaking the OpenAI chat.completions dialect
 * (including tools). OpenAI proper and OpenRouter both instantiate this —
 * they differ only in name, endpoint, headers, and env defaults.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string
  readonly reportsUsage = true
  readonly model: string
  private client: OpenAI

  constructor(name: string, opts: OpenAICompatibleOptions) {
    // The SDK retries transient 429/5xx/network errors with exponential backoff
    // internally, so a blip doesn't fail the whole run; `timeout` bounds each
    // request. Both are env-overridable.
    this.name = name
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      timeout: providerTimeoutMs(),
      maxRetries: providerMaxRetries(),
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders !== undefined ? { defaultHeaders: opts.defaultHeaders } : {}),
    })
    this.model = opts.model
  }

  async complete(req: CompletionRequest): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      // Same field rule as `converse`: OpenAI's current name, the documented one elsewhere.
      ...(this.name === OPENAI_ADAPTER
        ? { max_completion_tokens: maxTokens() }
        : { max_tokens: maxTokens() }),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    })

    return completion.choices[0]?.message?.content ?? ""
  }

  async converse(req: ConverseRequest, opts?: ConverseOptions): Promise<ConverseResult> {
    // Per-request options, so an abort cancels THIS call (retries included)
    // and a per-call retry count leaves the shared client untouched.
    const retries = resolveMaxRetries(req.providerOptions)
    const completion = await this.client.chat.completions.create(
      openAICompatibleRequestBody(this.name, this.model, req),
      {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(retries !== undefined ? { maxRetries: retries } : {}),
      },
    )

    const usage = openAIUsage(completion.usage)
    const choice = completion.choices[0]
    const message = choice?.message
    const parsed = message ? parseOpenAIMessage(message) : { text: "", toolCalls: [] }
    const finishReason = openAIFinishReason(choice?.finish_reason)
    // OpenRouter adds a top-level `provider` naming the upstream that served
    // the request; the SDK's response type does not know it, so read it loosely.
    const upstream =
      this.name === OPENROUTER_ADAPTER ? (completion as { provider?: unknown }).provider : undefined
    return {
      ...parsed,
      ...(usage ? { usage } : {}),
      finishReason,
      ...(typeof completion.model === "string" && completion.model
        ? { model: completion.model }
        : {}),
      ...(typeof completion.id === "string" && completion.id ? { responseId: completion.id } : {}),
      ...(typeof upstream === "string" && upstream ? { upstream } : {}),
    }
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-4.1") {
    super(OPENAI_ADAPTER, { apiKey, model })
  }
}
