import OpenAI from "openai"
import { maxTokens, providerMaxRetries, providerTimeoutMs } from "./clientOptions.js"
import type {
  AgentMessage,
  CompletionRequest,
  ConverseRequest,
  ConverseResult,
  Provider,
  ToolCall,
} from "./types.js"

/** Map provider-neutral messages to OpenAI chat messages (pure; tested). */
export function toOpenAIMessages(
  messages: AgentMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text })
    } else if (m.role === "assistant") {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.text,
      }
      if (m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      }
      out.push(msg)
    } else {
      // Each tool result becomes its own `tool` message keyed by the call id.
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content })
      }
    }
  }
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
    })
  }
  return { text, toolCalls }
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
  /** Extra headers sent on every request (e.g. OpenRouter attribution). */
  defaultHeaders?: Record<string, string>
}

/**
 * Shared core for providers speaking the OpenAI chat.completions dialect
 * (including tools). OpenAI proper and OpenRouter both instantiate this —
 * they differ only in name, endpoint, headers, and env defaults.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string
  private client: OpenAI
  private model: string

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
      max_tokens: maxTokens(), // match AnthropicProvider rather than the model default
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    })

    return completion.choices[0]?.message?.content ?? ""
  }

  async converse(req: ConverseRequest): Promise<ConverseResult> {
    const tools = req.tools.map((t): OpenAI.Chat.Completions.ChatCompletionTool => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens(), // match AnthropicProvider rather than the model default
      messages: [{ role: "system", content: req.system }, ...toOpenAIMessages(req.messages)],
      ...(tools.length > 0 ? { tools } : {}),
    })

    const message = completion.choices[0]?.message
    if (!message) return { text: "", toolCalls: [] }
    return parseOpenAIMessage(message)
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-4.1") {
    super("openai", { apiKey, model })
  }
}
