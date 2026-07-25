/**
 * The neutral model-invocation seam.
 *
 * A chat LLM is not the only kind of model a harness calls. Object detection,
 * speech recognition and forecasting are all "hand a model a request, get a
 * typed result" — they differ in payload, not in shape. So this seam unifies the
 * **arrow and the envelope** (`invoke`, {@link ModelResult}, {@link InvokeContext},
 * {@link ModelCaps}, `probe`) and deliberately leaves `Req`/`Res` **generic per
 * kind**.
 *
 * That generic-per-kind rule is load-bearing. Collapsing a chat request and an
 * image buffer into one `unknown` payload would erase exactly the typing that
 * makes a `DetectionResult` or a `ForecastResult` worth having. A kind declares
 * its own request and result types; the seam only guarantees how they travel.
 */

/**
 * What a model does. The listed kinds are conventions, not a closed set — an
 * application registers whatever kinds it needs, and the `(string & {})` arm
 * keeps editor completion for the common ones without restricting the type.
 */
export type ModelKind =
  "chat" | "vision.detect" | "audio.asr" | "timeseries.forecast" | (string & {})

/**
 * What an invocation can actually do. Declared by the implementation and
 * **checked** at the call site: asking for an unsupported capability fails loud
 * rather than silently degrading to a lesser path.
 */
export interface ModelCaps {
  /** `invokeStream` is implemented and may be called. */
  streaming: boolean
  /** The request may carry tool definitions and the result may carry tool calls. */
  tools: boolean
  /** The request may carry image/audio/binary parts. */
  multimodalInput: boolean
  /** Results carry a populated `usage`. */
  usage: boolean
}

/** Token accounting, for kinds billed per token. */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * Accounting for kinds that aren't billed per token — frames processed, seconds
 * of audio, rows forecast. A perception call's "usage" is the same idea in a
 * different unit, which is why the envelope carries both shapes.
 */
export interface UnitUsage {
  units: number
  /** What the units are (e.g. "frames", "seconds"). Free-form. */
  unit?: string
}

export type Usage = TokenUsage | UnitUsage

/** The uniform envelope every invocation returns, whatever its kind. */
export interface ModelResult<Res> {
  /** The typed result. Its shape is the kind's contract. */
  value: Res
  /** Cost/consumption, when the implementation reports it (`caps.usage`). */
  usage?: Usage
  /** Implementation-specific detail — latency, model revision, cache hits. */
  meta?: Record<string, unknown>
}

/**
 * Ambient per-call context. Carries the concerns that are cross-cutting rather
 * than payload-specific, so middleware can act on them uniformly across kinds.
 */
export interface InvokeContext {
  /** Append a line to the caller's run log. */
  log: (line: string) => void
  /** Cooperative cancellation. Implementations should honour it where they can. */
  signal?: AbortSignal
  /** Ties this call to a wider trace. Middleware propagates it. */
  correlationId?: string
  /** Wall-clock budget for this single call. */
  budget?: { maxDurationMs?: number }
}

export type HealthStatus = "up" | "down" | "degraded" | "unknown"

/** The outcome of a {@link ModelInvocation.probe}. */
export interface Health {
  status: HealthStatus
  /** Human-readable explanation, especially for `down`/`degraded`/`unknown`. */
  detail?: string
  meta?: Record<string, unknown>
}

/**
 * The normalized streaming event stream. Every implementation emits the same
 * three-event sequence per tool call — `onToolCallStart`, one or more
 * `onToolCallDelta`, then `onToolCallComplete` — even when the underlying API
 * delivers arguments in one piece. Consumers therefore write one handler, not
 * one per provider. Every handler is optional; a sink may care only about text.
 */
export interface StreamSink {
  onTextDelta?: (delta: string) => void
  onToolCallStart?: (toolCallId: string, toolName: string) => void
  onToolCallDelta?: (toolCallId: string, argumentsDelta: string) => void
  onToolCallComplete?: (toolCallId: string, toolName: string, args: string) => void
}

/**
 * Emit the canonical three-event sequence for a tool call whose arguments
 * arrived whole. Implementations backed by an API that doesn't stream argument
 * fragments call this so their output is indistinguishable from one that does.
 */
export function emitCompleteToolCall(
  sink: StreamSink,
  toolCallId: string,
  toolName: string,
  args: string,
): void {
  sink.onToolCallStart?.(toolCallId, toolName)
  sink.onToolCallDelta?.(toolCallId, args)
  sink.onToolCallComplete?.(toolCallId, toolName, args)
}

/**
 * One callable model capability. `Req` and `Res` belong to the kind: the chat
 * kind's `Req` carries messages and tools and its `Res` carries tool calls;
 * a `vision.detect` kind's `Req` is an image reference and its `Res` is a
 * detection struct with `caps.tools === false`.
 */
export interface ModelInvocation<Req, Res> {
  /** Identifies the concrete model within its kind (cf. a provider's name). */
  readonly id: string
  readonly kind: ModelKind
  readonly caps: ModelCaps
  invoke(req: Req, ctx: InvokeContext): Promise<ModelResult<Res>>
  /** Present only when `caps.streaming`. Use {@link invokeStreaming} to call it safely. */
  invokeStream?(req: Req, sink: StreamSink, ctx: InvokeContext): Promise<ModelResult<Res>>
  probe(): Promise<Health>
}

/** The identity of an invocation, without its payload types — what middleware sees. */
export interface ModelIdentity {
  id: string
  kind: ModelKind
  caps: ModelCaps
}

/** Narrow a {@link ModelInvocation} to its identity. */
export function modelIdentity(model: ModelInvocation<never, unknown>): ModelIdentity {
  return { id: model.id, kind: model.kind, caps: model.caps }
}

/**
 * Thrown when a call asks for something the invocation declared it cannot do.
 * The kernel never silently degrades — a caller that asked to stream and got a
 * buffered response back would have no way to notice.
 */
export class CapabilityError extends Error {
  readonly model: ModelIdentity
  readonly capability: keyof ModelCaps

  constructor(model: ModelIdentity, capability: keyof ModelCaps, detail?: string) {
    super(
      `model ${model.kind}:${model.id} does not support ${capability}${detail ? ` (${detail})` : ""}`,
    )
    this.name = "CapabilityError"
    this.model = model
    this.capability = capability
  }
}

/** Assert a capability before relying on it, failing loud when it's absent. */
export function requireCapability(
  model: ModelIdentity,
  capability: keyof ModelCaps,
  detail?: string,
): void {
  if (!model.caps[capability]) throw new CapabilityError(model, capability, detail)
}

/**
 * Stream an invocation, enforcing the capability gate. Fails loud when the
 * model declared `streaming: false` or left `invokeStream` unimplemented —
 * never falls back to the buffered path, because a caller that wanted deltas
 * would otherwise get none and be unable to tell.
 */
export async function invokeStreaming<Req, Res>(
  model: ModelInvocation<Req, Res>,
  req: Req,
  sink: StreamSink,
  ctx: InvokeContext,
): Promise<ModelResult<Res>> {
  const identity = modelIdentity(model)
  requireCapability(identity, "streaming")
  if (!model.invokeStream) {
    throw new CapabilityError(identity, "streaming", "declared streaming but has no invokeStream")
  }
  return model.invokeStream(req, sink, ctx)
}
