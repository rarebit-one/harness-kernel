import type { TokenUsage } from "../models/types.js"
import type { ProviderOptions } from "./options.js"

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
  /** The parsed arguments. Invalid or empty JSON parses to `{}`; see `argumentsText`. */
  input: Record<string, unknown>
  /**
   * The exact argument bytes the model emitted, when the dialect delivers them
   * as text (the OpenAI dialect does; Anthropic hands over an object and
   * leaves this absent). Preserved when the call is placed back into history,
   * so a resumed conversation carries what the model produced rather than a
   * re-serialisation of the parse. Present but unparseable means the call was
   * cut off; the loop refuses such a call rather than run it with `{}`.
   */
  argumentsText?: string
  /**
   * Opaque per-call provider data that must round-trip through history (a
   * thought signature, say). The kernel carries it and never reads it; an
   * adapter that needs it reads it back when serialising the call.
   */
  meta?: Record<string, unknown>
}

/**
 * Why the model stopped generating, normalised across dialects. `length`
 * means the output token cap cut the turn, so prose may be incomplete and a
 * tool call may be missing its tail; `content_filter` means the provider
 * refused; `unknown` means the provider reported nothing. A provider that
 * cannot report one sets `unknown`; absent is never "finished cleanly".
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown"

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
  /**
   * Per-call options for the adapter: token cap, prompt caching, response
   * format, OpenRouter routing. See `providers/options.ts`. An adapter that
   * cannot honour an option it was given throws rather than ignoring it.
   */
  providerOptions?: ProviderOptions
}

export interface ConverseResult {
  /** Assistant prose for this turn (may be empty when it only calls tools). */
  text: string
  /** Tools the model wants run; empty means the turn is final. */
  toolCalls: ToolCall[]
  /** Token accounting for this call, when the provider's API reports it. */
  usage?: TokenUsage
  /** Why generation stopped. The built-in adapters always set it. */
  finishReason?: FinishReason
  /**
   * The model id the response was served by, as the API reported it. This is
   * the *effective* model: with a fallback list it can differ from the one
   * requested. Absent when the API did not say; `chatModel` then fills in the
   * adapter's configured model.
   */
  model?: string
  /**
   * The provider's id for this response (an Anthropic message id, an OpenAI
   * completion id, an OpenRouter generation id). What a billing or audit query
   * against the provider keys on.
   */
  responseId?: string
  /**
   * The upstream that served the request behind an aggregator (OpenRouter's
   * `provider` field: "Anthropic", "Google Vertex", …). Absent for direct
   * adapters. This is what a data-policy audit needs, since it names who
   * actually processed the prompt.
   */
  upstream?: string
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
   * The model id this adapter was configured with (the per-run model, else its
   * env default, else its built-in default). Optional so a custom provider
   * written before this field existed still compiles; the built-in adapters
   * all set it, and `chatModel` reports it when a response names no model.
   */
  readonly model?: string
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
