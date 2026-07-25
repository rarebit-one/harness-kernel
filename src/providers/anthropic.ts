import Anthropic from "@anthropic-ai/sdk"
import { maxTokens, providerMaxRetries, providerTimeoutMs } from "./clientOptions.js"
import type {
  AgentMessage,
  CompletionRequest,
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

export class AnthropicProvider implements Provider {
  readonly name = "anthropic"
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

  async converse(req: ConverseRequest): Promise<ConverseResult> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens(),
      system: req.system,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(req.messages),
    })

    return parseAnthropicContent(message.content)
  }
}
