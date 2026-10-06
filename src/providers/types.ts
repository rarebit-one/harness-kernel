import type { TokenUsage } from "../models/types.js"

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

/** The reply to a ToolCall. */
export interface ToolResult {
  toolCallId: string
  /** The string projection sent to the model — the only part a provider serializes. */
  content: string
  /**
   * The typed payload `content` was projected from, when the tool produced one.
   * Providers ignore it; callers and clients read it to avoid re-parsing a
   * struct back out of the string.
   */
  structured?: unknown
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
  /** Token accounting for this call, when the provider's API reports it. */
  usage?: TokenUsage
}

/**
 * Per-call options for {@link Provider.converse}.
 *
 * `signal` aborts the in-flight HTTP request rather than waiting it out: the
 * SDK-backed adapters hand it to the SDK as a per-request option, so a caller
 * cancel (or the loop's own deadline) stops a long generation mid-flight. A
 * provider that cannot honour it should still check it before starting.
 */
export interface ConverseOptions {
  signal?: AbortSignal
}

export interface Provider {
  readonly name: string
  /**
   * True when `converse` always populates `ConverseResult.usage`. `chatModel`
   * declares `caps.usage` from this, so a provider that reports nothing (the
   * mock, most custom providers) never advertises usage it will not deliver.
   */
  readonly reportsUsage?: boolean
  /** One-shot completion (no tools) — kept for simple callers. */
  complete(req: CompletionRequest): Promise<string>
  /** One step of a tool-use conversation; the agent loop drives the rest. */
  converse(req: ConverseRequest, opts?: ConverseOptions): Promise<ConverseResult>
}
