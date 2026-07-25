export interface CompletionRequest {
  system: string
  prompt: string
}

/** A tool offered to the model, described by a JSON-Schema input shape. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The model's request to invoke a tool. */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** The runner's reply to a ToolCall. */
export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

/** Provider-neutral conversation turn (mapped to each provider's wire format). */
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] }

export interface ConverseRequest {
  system: string
  messages: AgentMessage[]
  tools: ToolSpec[]
}

export interface ConverseResult {
  /** Assistant prose for this turn (may be empty when it only calls tools). */
  text: string
  /** Tools the model wants run; empty means the turn is final. */
  toolCalls: ToolCall[]
}

export interface Provider {
  readonly name: string
  /** One-shot completion (no tools) — kept for simple callers. */
  complete(req: CompletionRequest): Promise<string>
  /** One step of a tool-use conversation; the agent loop drives the rest. */
  converse(req: ConverseRequest): Promise<ConverseResult>
}
