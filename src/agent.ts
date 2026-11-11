import {
  runEventEmitter,
  type RunEvent,
  type RunEventSink,
  type RunOutcome,
  type StopReason,
  type ToolSucceededEvent,
} from "./events.js"
import {
  nativeLoop,
  runWithEvents,
  type LoopConsumed,
  type LoopContext,
  type LoopLimits,
  type LoopRequest,
  type LoopResult,
  type TerminalCall,
} from "./loop.js"
import { asChatModel, chatRequest, type ChatModel } from "./models/chat.js"
import { deadlineSignal, isAbortError } from "./signals.js"
import type { InvokeContext, TokenUsage, Usage } from "./models/types.js"
import type { ProviderOptions } from "./providers/options.js"
import type {
  AgentMessage,
  FinishReason,
  Provider,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "./providers/types.js"
import { executeTool, type Tool } from "./tools/registry.js"
import { toToolSpecs, toolDispatch, type ToolMetadata } from "./tools/metadata.js"
import { assertToolConcurrency, runInSegments, type ToolConcurrency } from "./tools/concurrency.js"
import { invalidInputRefusal } from "./tools/validate.js"

/** What {@link runAgent} and {@link runConversation} share. */
export interface LoopRunOptions {
  /**
   * The chat model driving the loop. A bare {@link Provider} is accepted and
   * adapted onto the model seam internally, so existing callers are unaffected;
   * pass a {@link ChatModel} to drive the loop through a registry-resolved,
   * middleware-wrapped invocation instead.
   */
  provider: Provider | ChatModel
  system: string
  tools: Tool[]
  /**
   * Per-call provider options — token cap, prompt caching, response format,
   * OpenRouter routing — sent on every model call the run makes. See
   * `providers/options.ts`.
   */
  providerOptions?: ProviderOptions
  maxSteps?: number
  /**
   * Wall-clock budget for the whole loop in ms. Enforced both between steps and
   * mid-call (the in-flight model request and tool are aborted); when exceeded
   * the loop stops cleanly and returns what's accumulated (with a note) rather
   * than throwing. Defaults to `RUNNER_RUN_TIMEOUT_MS` if set, else 10min.
   */
  maxDurationMs?: number
  /**
   * Cost budget for the whole loop in US dollars, counted from the cost each
   * model call reports. Absent (the default) means unlimited. When reached, the
   * run stops before running the tools the last turn asked for, with
   * `outcome: "cost_exhausted"` and the accumulated prose. See
   * `LoopLimits.maxCostUsd` for what counts and what an unpriced call does.
   */
  maxCostUsd?: number
  /**
   * Tell the model, on every step, how many steps and how much time remain.
   * Off by default. Advisory only: the loop's limits stay hard. See
   * `LoopLimits.budgetVisible`.
   */
  budgetVisible?: boolean
  /**
   * Check each tool call's arguments against the tool's `inputSchema` before
   * running it. Off by default. A call that does not fit is not run: the model
   * gets an error result naming the failing arguments, `tool.failed` reports
   * `reason: "invalid_input"`, and a terminal call refused this way does not
   * end the run. Applies to every tool the run has, connector tools included;
   * see `validateToolInput` for the subset of JSON Schema it checks.
   */
  validateToolInput?: boolean
  /**
   * Cancels the run. On abort the in-flight model request and tool are
   * stopped, no summary call is made, and the run resolves (never rejects)
   * with the prose accumulated so far and `outcome: "canceled"`.
   */
  signal?: AbortSignal
  /** The run's id, handed to tools on `ToolContext.runId`. */
  runId?: string
  /**
   * Run a step's concurrency-safe tool calls in parallel. Off by default:
   * every call runs in series, in the model's order. See `ToolConcurrency`.
   */
  toolConcurrency?: ToolConcurrency
  log?: (line: string) => void
  /**
   * Structured event sink. Absent (the default) means the loop behaves exactly
   * as it did before events existed — `log` is unaffected either way, and the
   * return value is unchanged. See `events.ts` for why the kernel emits this
   * stream but never stores it.
   */
  emit?: RunEventSink
}

/** A single-shot run: one user prompt in, the final prose out. */
export interface RunAgentOptions extends LoopRunOptions {
  userPrompt: string
}

/** A conversational run: the history so far in, the whole transcript out. */
export interface RunConversationOptions extends LoopRunOptions {
  /**
   * The conversation so far, oldest first, ending with the new user message
   * (or with the tool results the model is waiting for). The array is not
   * mutated; the result carries a new one.
   */
  messages: AgentMessage[]
}

/**
 * What {@link runConversation} returns: everything a conversational caller
 * needs to store the turn, bill it, and answer with it.
 */
export interface ConversationResult {
  /** The final assistant prose. Empty when a terminal tool answered without prose. */
  text: string
  /** The seed followed by every message the loop appended. Store this; seed the next turn with it. */
  messages: AgentMessage[]
  /**
   * This run's full event stream, in order. The same events reached `emit` as
   * they happened; this is a per-call recording for a caller with nowhere else
   * to put them, not a store — nothing is kept between calls.
   */
  events: RunEvent[]
  /** Token usage summed over every model call that reported it; absent if none did. */
  usage?: TokenUsage
  steps: number
  outcome: RunOutcome
  stopReason: StopReason
  /** The terminal-tool call that ended the run, when one did. Its `input` is the structured answer. */
  terminal?: TerminalCall
  /**
   * The external tool calls parked when `outcome` is `suspended`. Execute them,
   * then resume with `withToolResults(messages, results)` as the next seed and
   * `remainingLimits(limits, consumed)` as the budget.
   */
  pending?: ToolCall[]
  /** What this run spent: steps, wall-clock ms and usage. */
  consumed: LoopConsumed
  /** Which adapter served the run (`"anthropic"`, `"openrouter"`, `"mock"`, a custom model's id). */
  provider: string
  /** The model id the last response named, else the adapter's configured model. */
  model?: string
  /** Every response id the provider reported, in call order. */
  responseIds: string[]
  /**
   * Behind an aggregator, who actually served the last response (OpenRouter's
   * response-level `provider`, e.g. "Anthropic"). This is what a data-policy
   * audit reads: `provider` names the adapter, `upstream` names the vendor the
   * prompt reached. Absent for direct adapters.
   */
  upstream?: string
  /**
   * Why the last model call stopped generating. `length` together with
   * `stopReason: "length"` is a cut-off prose answer; a cut-off tool call never
   * becomes the answer (the loop refuses it), so after `terminal_tool` this is
   * never `length`.
   */
  finishReason?: FinishReason
}

const DEFAULT_MAX_STEPS = 12
const FALLBACK_MAX_DURATION_MS = 10 * 60 * 1000

/** Resolve the wall-clock run budget from env, falling back to 10 minutes. */
function defaultMaxDurationMs(): number {
  const raw = Number(process.env.RUNNER_RUN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_MAX_DURATION_MS
}
const FALLBACK_MAX_TOOL_RESULT_BYTES = 64 * 1024

/**
 * Resolve a partial budget to the concrete numbers a {@link LoopRequest} needs.
 *
 * One place, deliberately. A {@link Loop} is handed numbers rather than
 * optionals, so if each caller resolved its own defaults a second loop
 * implementation could silently run to a different ceiling than the one the
 * kernel ships. `runAgent`, `runConversation` and `NativeEngine` all come here.
 */
export function resolveLoopLimits(limits?: {
  maxSteps?: number | undefined
  maxDurationMs?: number | undefined
  maxCostUsd?: number | undefined
  budgetVisible?: boolean | undefined
}): LoopLimits {
  const maxCostUsd = limits?.maxCostUsd
  // No default: a cost budget exists only when the caller set one. A NaN or a
  // negative would make the comparison never (or always) fire, so it is
  // refused rather than run as a limit that silently is not one.
  if (maxCostUsd !== undefined && !(maxCostUsd >= 0)) {
    throw new RangeError(`maxCostUsd must be a non-negative number, got ${maxCostUsd}`)
  }
  return {
    maxSteps: limits?.maxSteps ?? DEFAULT_MAX_STEPS,
    maxDurationMs: limits?.maxDurationMs ?? defaultMaxDurationMs(),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(limits?.budgetVisible ? { budgetVisible: true } : {}),
  }
}

/**
 * The floor a resumed run keeps however much was spent: one step, so the
 * parked call's result is always delivered and answered, and a minute of
 * wall clock, enough for that one turn. A resumed run is a continuation, not
 * a fresh run, but it is never a run that cannot take its first step.
 */
const RESUME_MIN_STEPS = 1
const RESUME_MIN_DURATION_MS = 60 * 1000

/**
 * The budget left after a `suspended` run: the original limits minus what that
 * run `consumed`, floored so the first resumed step always runs (the reserved-
 * final-step rule). A caller resuming a conversation passes this as `limits`;
 * resuming with the ORIGINAL limits would make every suspension a fresh budget.
 */
export function remainingLimits(limits: LoopLimits, consumed: LoopConsumed): LoopLimits {
  return {
    maxSteps: Math.max(RESUME_MIN_STEPS, limits.maxSteps - consumed.steps),
    maxDurationMs: Math.max(RESUME_MIN_DURATION_MS, limits.maxDurationMs - consumed.durationMs),
    // No floor is needed: the loop checks cost after a turn, so a resumed run's
    // first step runs even on a zero budget. Only reported cost was counted, so
    // only reported cost is subtracted.
    ...(limits.maxCostUsd !== undefined
      ? {
          maxCostUsd: Math.max(0, limits.maxCostUsd - (consumed.usage?.reportedCost?.amount ?? 0)),
        }
      : {}),
    ...(limits.budgetVisible ? { budgetVisible: true } : {}),
  }
}

/**
 * The seed for resuming a `suspended` run: `messages` with `results` answering
 * the parked calls. When the suspended step also ran server-side tools, the
 * transcript already ends with their results, and these are merged into that
 * same tool turn rather than appended as a second one — every dialect wants
 * one tool turn answering one assistant turn. Neither array is mutated.
 */
export function withToolResults(messages: AgentMessage[], results: ToolResult[]): AgentMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role === "tool") {
    return [...messages.slice(0, -1), { role: "tool", results: [...last.results, ...results] }]
  }
  return [...messages, { role: "tool", results: [...results] }]
}

/**
 * Cap on tool output fed back into the conversation, independent of the sandbox
 * buffer caps — an 8 MB stdout would otherwise blow the context window.
 * Env-overridable (`RUNNER_MAX_TOOL_RESULT_BYTES`, default 64 KiB) and resolved
 * per call so a changed env takes effect without a reload.
 */
export function maxToolResultBytes(): number {
  const raw = Number(process.env.RUNNER_MAX_TOOL_RESULT_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FALLBACK_MAX_TOOL_RESULT_BYTES
}

/**
 * The reversibility fields a tool declares, copied at call time.
 *
 * Each is spread only when declared: absent means "makes no claim", which is a
 * different fact from `reversible: false` ("declared irreversible") and a
 * rollback consumer must be able to tell them apart.
 */
function undoFields(
  meta?: ToolMetadata,
): Partial<
  Pick<ToolSucceededEvent, "reversible" | "undoToolName" | "undoWindowSeconds" | "replay">
> {
  return {
    ...(meta?.reversible !== undefined ? { reversible: meta.reversible } : {}),
    ...(meta?.undoToolName !== undefined ? { undoToolName: meta.undoToolName } : {}),
    ...(meta?.undoWindowSeconds !== undefined ? { undoWindowSeconds: meta.undoWindowSeconds } : {}),
    ...(meta?.replay !== undefined ? { replay: meta.replay } : {}),
  }
}

/** A short, human-readable rendering of an abort reason for the run note. */
function describeReason(reason: unknown): string {
  if (typeof reason === "string") return reason
  // The DOMException a bare `abort()` produces says nothing a caller chose.
  if (reason instanceof Error && reason.name !== "AbortError") return reason.message
  return ""
}

/**
 * A detached copy of a tool's arguments for the event stream.
 *
 * The sink must never be able to change what the tool receives: emitting is
 * observation, and an observer that mutates `input` in place would make merely
 * *attaching* a sink alter the run's side effects. `structuredClone` handles
 * the nested case; the shallow fallback covers a value it refuses (a function,
 * say) rather than letting a clone failure take the run down.
 */
function detach(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(input)
  } catch {
    return { ...input }
  }
}

/**
 * The result a tool call gets when the run stopped before it could start. A
 * stopped run must still return a transcript with every call answered: a
 * consumer that stores `messages` and resumes the conversation sends it back
 * to a provider, and every provider rejects a tool call with no result.
 */
function notRun(callId: string): ToolResult {
  return {
    toolCallId: callId,
    content: "not run: the run was stopped before this tool call",
    isError: true,
  }
}

function truncate(text: string, max = maxToolResultBytes()): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]`
}

/**
 * Add one call's usage to the running total. Only token usage is summed: a
 * unit-billed kind (`units`) has no place in a chat loop's total, and a call
 * that reported nothing leaves the total as it was rather than zeroing it.
 */
function addUsage(total: TokenUsage | undefined, next: Usage | undefined): TokenUsage | undefined {
  if (!next || "units" in next) return total
  const sum: TokenUsage = { ...(total ?? {}) }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    const n = next[key]
    if (typeof n === "number") sum[key] = (sum[key] ?? 0) + n
  }
  // Cost is summed by amount. Every reporter bills in USD today, and the type
  // admits nothing else, so there is no mixed-currency case to guard.
  if (next.reportedCost) {
    sum.reportedCost = {
      amount: (sum.reportedCost?.amount ?? 0) + next.reportedCost.amount,
      currency: next.reportedCost.currency,
    }
  }
  return sum
}

/**
 * A call whose raw arguments were cut off: the dialect delivered text and that
 * text does not parse as a JSON object. The parsed `input` is `{}` in that
 * case, which would run the tool with nothing, so the loop refuses the call
 * instead. Empty or whitespace text is the ambiguous case: some upstreams emit
 * it for a genuine zero-argument call, and a turn cut off before the JSON
 * began looks identical. It is read as truncated only when the turn's
 * `finishReason` is `length`, which is the one situation where the cut-off
 * reading is the safe one. A dialect that delivers no text (Anthropic) cannot
 * be judged here.
 */
export function isTruncatedCall(call: ToolCall, finishReason?: FinishReason): boolean {
  const raw = call.argumentsText
  if (raw === undefined) return false
  if (raw.trim() === "") return finishReason === "length"
  try {
    const parsed: unknown = JSON.parse(raw)
    return !(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
  } catch {
    return true
  }
}

/** The seed a loop can continue: non-empty, and not waiting on the caller. */
function assertSeed(messages: AgentMessage[]): void {
  const last = messages[messages.length - 1]
  if (!last) {
    throw new Error(
      "conversation seed is empty: the loop needs at least one user message to answer",
    )
  }
  if (last.role === "assistant") {
    throw new Error(
      "conversation seed ends with an assistant message, so the model has nothing to answer: " +
        "end it with a user message, or with the tool results the model is waiting for",
    )
  }
  if (last.role === "tool") {
    // A tool turn answers the assistant turn before it, call for call. A seed
    // that answers only some of them (a resume that forgot a pending call) is
    // refused here, where it costs nothing, rather than by the provider.
    const prev = messages[messages.length - 2]
    const asked = prev?.role === "assistant" ? prev.toolCalls.map((c) => c.id) : []
    const answered = new Set(last.results.map((r) => r.toolCallId))
    const missing = asked.filter((id) => !answered.has(id))
    if (prev?.role !== "assistant" || missing.length > 0) {
      throw new Error(
        "conversation seed ends with tool results that do not answer the assistant turn before " +
          `them${missing.length > 0 ? ` (unanswered call ids: ${missing.join(", ")})` : ""}; ` +
          "a resumed run needs a result for every pending call, a rejection included",
      )
    }
  }
}

/**
 * The external calls a resumed seed answers: the tool turn at its tail, matched
 * against the assistant turn before it, for the calls the loop parked. A parked
 * call carries `external: true` in the transcript, so this does not depend on
 * which tools the resumed run was given: a caller that dropped the external
 * tool still sees the call closed, and a server-side tool it dropped is not
 * mistaken for one (its call already closed in the run that executed it). A
 * hand-built seed without the marker is still recognised by its tool's
 * dispatch, when the tool is present.
 */
function answeredExternalCalls(
  messages: AgentMessage[],
  byName: Map<string, Tool>,
): Array<{ call: ToolCall; result: ToolResult }> {
  const last = messages[messages.length - 1]
  const prev = messages[messages.length - 2]
  if (last?.role !== "tool" || prev?.role !== "assistant") return []
  const results = new Map(last.results.map((r) => [r.toolCallId, r]))
  const answered: Array<{ call: ToolCall; result: ToolResult }> = []
  for (const call of prev.toolCalls) {
    const tool = byName.get(call.name)
    const result = results.get(call.id)
    const parked =
      call.external === true || (tool !== undefined && toolDispatch(tool) === "external")
    if (result && parked) answered.push({ call, result })
  }
  return answered
}

/** The result a parked call gets when the run ends before the caller could answer it. */
function notAnswered(callId: string, why: string): ToolResult {
  return { toolCallId: callId, content: `not run: ${why}`, isError: true }
}

/**
 * The one ephemeral line the model sees when `budgetVisible` is on. The cost
 * clause appears only under a cost limit, so a run without one sees exactly
 * the line it always did.
 */
function budgetLine(
  stepsLeft: number,
  maxSteps: number,
  msLeft: number,
  costLeft?: number,
): AgentMessage {
  const seconds = Math.max(0, Math.round(msLeft / 1000))
  const left =
    costLeft === undefined
      ? `${stepsLeft} of ${maxSteps} step(s) and ${seconds}s`
      : `${stepsLeft} of ${maxSteps} step(s), ${seconds}s and $${costLeft.toFixed(4)} of cost`
  return {
    role: "user",
    text: `[budget] ${left} remain. Plan to finish within them.`,
  }
}

/** The cost a call reported, when it reported one. */
function reportedAmount(usage: Usage | undefined): number | undefined {
  return usage && !("units" in usage) ? usage.reportedCost?.amount : undefined
}

/** The finer reason a custom loop's bare outcome implies, when it reported none. */
function stopReasonFor(outcome: RunOutcome): StopReason {
  return outcome === "completed" ? "end_turn" : outcome
}

/**
 * Thrown by {@link runAgent} when the model's final prose was cut off at the
 * output token cap (`stopReason: "length"`, or a budget summary that ended
 * with `finishReason: "length"`). A bare string cannot say "this is not whole", and a caller
 * that got one would apply it as an answer, so the single-shot form refuses
 * instead. The partial text and the full result ride on the error for a
 * caller that wants them; {@link runConversation} returns the same run with
 * `stopReason: "length"` and never throws for it.
 */
export class TruncatedAnswerError extends Error {
  /** The cut-off prose, exactly as the model left it. */
  readonly text: string
  /** The whole run, as `runConversation` would have returned it. */
  readonly result: ConversationResult

  constructor(result: ConversationResult) {
    super(
      "the answer was cut off at the output token limit and is not whole; raise " +
        "providerOptions.maxTokens or use runConversation(), which returns the partial " +
        'text with stopReason "length" instead of throwing',
    )
    this.name = "TruncatedAnswerError"
    this.text = result.text
    this.result = result
  }
}

/**
 * Drives a provider-agnostic tool-use loop: the model converses, the runner
 * executes any requested tools in the sandbox, feeds the results back, and
 * repeats until the model stops calling tools (or the step budget is hit). The
 * model orchestrates; deterministic work happens in the tools.
 *
 * This is the single-shot form: one user prompt in, the final prose out. It is
 * {@link runConversation} with a one-message seed, kept because most callers
 * want exactly that and nothing more. The one thing a string cannot carry is
 * "cut off", so a `length` stop throws {@link TruncatedAnswerError} here
 * rather than returning partial prose that reads as complete.
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
  const { userPrompt, ...rest } = options
  const result = await runConversation({
    ...rest,
    messages: [{ role: "user", text: userPrompt }],
  })
  // `stopReason: "length"` is the plain case; a budget summary cut at the cap
  // ends `steps_exhausted` with `finishReason: "length"`, and its text is just
  // as partial. A canceled, timed-out or cost-stopped run is not judged here:
  // the cancellation contract is that it resolves with its note, never
  // rejects, even when the last turn to land before the stop happened to be cut.
  const stopped =
    result.outcome === "canceled" ||
    result.outcome === "timed_out" ||
    result.outcome === "cost_exhausted"
  if (!stopped && (result.stopReason === "length" || result.finishReason === "length")) {
    throw new TruncatedAnswerError(result)
  }
  // A single-shot caller has nowhere to put a continuation: returning the
  // parked run's (usually empty) prose as the answer would silently drop the
  // transcript, the pending calls and the spent budget. Refuse, carrying all
  // three, so the caller can still resume through `runConversation`.
  if (result.outcome === "suspended") throw new SuspendedRunError(result)
  return result.text
}

/**
 * Thrown by {@link runAgent} when the model called an external tool: the run is
 * `suspended`, and a bare string cannot carry what resuming needs. The whole
 * result rides on the error (`messages`, `pending`, `consumed`), so nothing is
 * lost; use `runConversation` to resume, or to avoid the throw altogether.
 */
export class SuspendedRunError extends Error {
  readonly result: ConversationResult

  constructor(result: ConversationResult) {
    super(
      `the run suspended on ${result.pending?.length ?? 0} external tool call(s) and has no ` +
        "final answer; runAgent() cannot resume it. Use runConversation(), which returns the " +
        'parked calls with outcome "suspended" instead of throwing',
    )
    this.name = "SuspendedRunError"
    this.result = result
  }
}

/**
 * Run the tool-use loop over a conversation: the stored history plus the new
 * user turn in, the whole transcript out, with the structured answer when a
 * terminal tool gave one.
 *
 * The kernel stores nothing between calls. A conversational application keeps
 * `result.messages` wherever it keeps its state and seeds the next call with
 * it; what the kernel owes it is a faithful transcript, a summed bill, the
 * reason the run stopped, and the name of what served it.
 */
export async function runConversation(
  options: RunConversationOptions,
): Promise<ConversationResult> {
  // A `Provider` is adapted onto the model seam; a `ChatModel` passes straight
  // through. Either way the loop talks to one interface, so a
  // middleware-wrapped or registry-resolved model drives it identically.
  const log = options.log ?? (() => {})
  const model = asChatModel(options.provider)
  // Recorded before the caller's sink sees each event, so a sink that throws
  // (which the emitter absorbs) still leaves the recording complete.
  const events: RunEvent[] = []
  const sink: RunEventSink = (event) => {
    events.push(event)
    options.emit?.(event)
  }
  const result = await runWithEvents(
    nativeLoop,
    {
      model,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      limits: resolveLoopLimits(options),
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      ...(options.toolConcurrency ? { toolConcurrency: options.toolConcurrency } : {}),
      ...(options.validateToolInput ? { validateToolInput: true } : {}),
    },
    {
      log,
      events: runEventEmitter(sink, log),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
    },
  )
  return {
    text: result.text,
    // A custom loop that reports no transcript still must not hand the caller
    // its own seed array back: the doc promises a new one.
    messages: result.messages ?? [...options.messages],
    events,
    steps: result.steps,
    outcome: result.outcome,
    stopReason: result.stopReason ?? stopReasonFor(result.outcome),
    provider: result.provider ?? model.id,
    responseIds: result.responseIds ?? [],
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.upstream !== undefined ? { upstream: result.upstream } : {}),
    ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.terminal ? { terminal: result.terminal } : {}),
    ...(result.pending && result.pending.length > 0 ? { pending: result.pending } : {}),
    // A custom loop that reports no spend still spent its steps; the wall clock
    // is unknown to us then, so it is reported as 0 rather than invented.
    consumed: result.consumed ?? { steps: result.steps, durationMs: 0 },
  }
}

/**
 * The native tool-use loop, as a {@link Loop}.
 *
 * Exported for `loop.ts` to wrap; applications reach it through `nativeLoop`
 * rather than calling this directly. It is the whole of the kernel's control
 * flow, and the only place any of it lives — `runAgent`, `runConversation` and
 * `nativeLoop` all come here, so they cannot drift.
 */
export async function runNativeLoop(req: LoopRequest, loopCtx: LoopContext): Promise<LoopResult> {
  const { model, system, tools, providerOptions } = req
  const { maxSteps, maxDurationMs, maxCostUsd } = req.limits
  const log = loopCtx.log

  // Checked before the first model call: a bad seed is a configuration error,
  // and the cheapest failure is the one that spends no tokens.
  assertSeed(req.messages)
  assertToolConcurrency(req.toolConcurrency)

  // One signal for the whole run: the caller's cancel merged with the run's own
  // deadline. It reaches every model call (through `InvokeContext.signal`, down
  // to the provider's HTTP request) and every tool (through `ToolContext`), so
  // neither a cancel nor the deadline has to wait for an in-flight step to end.
  const deadline = deadlineSignal(maxDurationMs)
  const signal = loopCtx.signal ? AbortSignal.any([loopCtx.signal, deadline]) : deadline
  const ctx: InvokeContext = { log, signal, budget: { maxDurationMs } }
  // The emitter is the caller's: `seq` is per RUN, not per loop, so a loop that
  // made its own would restart the numbering mid-stream.
  const events = loopCtx.events

  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  const specs = toToolSpecs(tools)
  // The run's opt-in, applied per call. A call to a tool this run lacks is
  // never safe: it runs alone, and is refused there as unknown.
  const concurrency = req.toolConcurrency
  const segments = concurrency && {
    maxConcurrent: concurrency.maxConcurrent,
    safe: (call: ToolCall) => {
      const tool = byName.get(call.name)
      return tool !== undefined && concurrency.concurrencySafe(tool)
    },
  }
  /** Close a parked call this run will not hand to the caller after all. */
  const closePending = (call: ToolCall, why: string) => {
    // Closed here, so no longer parked: the mark comes off the transcript's
    // copy, or a later continuation would close this call a second time.
    delete call.external
    log(`tool ${call.name} pending call dropped: ${why}`)
    events.emit({
      type: "tool.failed",
      step,
      callId: call.id,
      name: call.name,
      reason: "aborted",
      error: `not run: ${why}`,
    })
  }
  // The seed is the caller's. It is copied so the loop's appends never reach
  // the array it was handed: a service that kept the seed for its own records
  // must not find it grown.
  const messages: AgentMessage[] = [...req.messages]
  const startedAt = Date.now()
  const deadlineAt = startedAt + maxDurationMs
  // The budget line is part of the REQUEST, never of `messages`: a stored
  // transcript must not fill up with the loop's own bookkeeping, and the
  // trailing position keeps the cached prefix (system, tools, history) intact.
  const request = (toolSpecs: ToolSpec[], stepsLeft?: number) =>
    chatRequest(
      system,
      req.limits.budgetVisible && stepsLeft !== undefined
        ? [
            ...messages,
            budgetLine(
              stepsLeft,
              maxSteps,
              deadlineAt - Date.now(),
              maxCostUsd !== undefined
                ? Math.max(0, maxCostUsd - (usage?.reportedCost?.amount ?? 0))
                : undefined,
            ),
          ]
        : messages,
      toolSpecs,
      undefined,
      providerOptions,
    )
  const provider = model.id

  let finalText = ""
  let lastAssistantText = ""
  let exhausted = false
  let timedOut = false
  let stepsTaken = 0
  let step = 0
  let usage: TokenUsage | undefined
  let servedModel: string | undefined
  let servedUpstream: string | undefined
  let terminal: TerminalCall | undefined
  let lastFinish: FinishReason | undefined
  let cutOff = false
  let unpricedNoted = false
  const responseIds: string[] = []
  let pending: ToolCall[] = []

  /** Everything a result carries besides the three the caller decides per path. */
  const result = (text: string, outcome: RunOutcome, stopReason: StopReason): LoopResult => ({
    text,
    steps: stepsTaken,
    outcome,
    stopReason,
    messages,
    provider,
    responseIds,
    consumed: {
      steps: stepsTaken,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    },
    // Only a run that ended BECAUSE it parked these reports them.
    ...(pending.length > 0 && outcome === "suspended" ? { pending } : {}),
    ...(servedModel !== undefined ? { model: servedModel } : {}),
    ...(servedUpstream !== undefined ? { upstream: servedUpstream } : {}),
    ...(lastFinish !== undefined ? { finishReason: lastFinish } : {}),
    ...(usage ? { usage } : {}),
    // Only a run that ended BECAUSE of the terminal call reports it.
    ...(terminal && stopReason === "terminal_tool" ? { terminal } : {}),
  })

  /**
   * The run was stopped mid-flight. `signal.reason` says by whom: the deadline
   * signal's own reason means the budget ran out (`timed_out`); anything else
   * is the caller's (`canceled`). Either way it is a clean stop — the
   * accumulated prose comes back with a note, no summary call is spent, and
   * nothing is thrown, so `runWithEvents` never reports it as `failed`.
   */
  const stopped = (): LoopResult => {
    const accumulated = lastAssistantText || "(no output before the run was stopped)"
    if (signal.reason === deadline.reason) {
      log(
        `reached run time budget (${maxDurationMs}ms) during step ${step}; in-flight work aborted`,
      )
      events.emit({ type: "run.budget_exhausted", kind: "duration", step })
      const text = `${accumulated}\n\n[run stopped: wall-clock budget of ${maxDurationMs}ms exceeded]`
      return result(text, "timed_out", "timed_out")
    }
    const why = describeReason(signal.reason)
    log(`run canceled during step ${step}${why ? `: ${why}` : ""}`)
    const text = `${accumulated}\n\n[run stopped: canceled${why ? ` (${why})` : ""}]`
    return result(text, "canceled", "canceled")
  }

  // A resumed run closes what the suspended one left open: each parked call the
  // seed now answers gets its `tool.succeeded` or `tool.failed` here, at step 0,
  // so a consumer following the stream across the two runs sees every
  // `tool.pending` matched. Nothing is executed; the caller already did that.
  for (const { call, result: answer } of answeredExternalCalls(messages, byName)) {
    if (answer.rejected || answer.isError) {
      // Declined by policy, or executed by the caller and failed: both close as
      // failures, and the reason keeps them apart. The stream must not say
      // "succeeded" about a result the conversation records as an error.
      const reason = answer.rejected ? "rejected" : "threw"
      log(`tool ${call.name} ${reason === "rejected" ? "rejected by" : "failed at"} the caller`)
      events.emit({
        type: "tool.failed",
        step: 0,
        callId: call.id,
        name: call.name,
        reason,
        error: answer.content,
      })
    } else {
      log(`tool ${call.name} answered by the caller (${answer.content.length} bytes)`)
      events.emit({
        type: "tool.succeeded",
        step: 0,
        callId: call.id,
        name: call.name,
        bytes: Buffer.byteLength(answer.content, "utf8"),
        ...undoFields(byName.get(call.name)?.meta),
      })
    }
  }

  try {
    for (; step < maxSteps; step += 1) {
      // Wall-clock budget, checked between steps. The deadline signal also
      // aborts an in-flight model request or tool, so a step can no longer
      // overshoot the budget by its whole duration — only by however long a
      // call that ignores its signal takes to return.
      if (Date.now() >= deadlineAt) {
        timedOut = true
        log(`reached run time budget (${maxDurationMs}ms) after ${step} step(s)`)
        events.emit({ type: "run.budget_exhausted", kind: "duration", step })
        break
      }
      signal.throwIfAborted()
      const turnResult = await model.invoke(request(specs, maxSteps - step), ctx)
      const turn = turnResult.value
      stepsTaken = step + 1
      // The transcript keeps a detached copy of each call: a tool is handed its
      // own copy below, so an executor that mutates its input can rewrite
      // neither what the model said nor what is replayed on the next request.
      const calls = turn.toolCalls.map((c) => ({ ...c, input: detach(c.input) }))
      messages.push({ role: "assistant", text: turn.text, toolCalls: calls })
      if (turn.text) lastAssistantText = turn.text
      usage = addUsage(usage, turnResult.usage)
      // Both describe the LAST response, so a response that names neither
      // clears an earlier value rather than letting it stand in an audit.
      servedModel = turn.model
      servedUpstream = turn.upstream
      if (turn.responseId) responseIds.push(turn.responseId)
      lastFinish = turn.finishReason
      events.emit({
        type: "model.turn",
        step,
        text: turn.text,
        toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name })),
        ...(turnResult.usage ? { usage: turnResult.usage } : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.responseId ? { responseId: turn.responseId } : {}),
        ...(turn.upstream ? { upstream: turn.upstream } : {}),
        ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
      })
      // A model that ignored its signal can still answer after the stop. The
      // turn happened, so it is recorded above and its prose is kept, but the
      // outcome is the stop's — `canceled` or `timed_out`, never `completed` —
      // and none of the tools it asked for run. Each call it asked for still
      // gets a result, so the transcript it leaves behind can be resumed.
      if (signal.aborted) {
        if (calls.length > 0) {
          messages.push({ role: "tool", results: calls.map((c) => notRun(c.id)) })
        }
        return stopped()
      }

      // The cost budget, checked once the turn's cost is known. Only what the
      // calls reported counts: an unpriced turn is unknown, not free, and not
      // a number either, so it is noted once and the limit runs on what was
      // reported. A turn that answered in prose finishes the run as usual
      // (nothing more would be spent); a turn that asked for tools is stopped
      // before any of them start, like a stop that lands after the turn, and
      // without the summary call the step budget gets — that call would spend
      // past a limit that is already reached.
      if (maxCostUsd !== undefined) {
        if (reportedAmount(turnResult.usage) === undefined && !unpricedNoted) {
          unpricedNoted = true
          log(
            `step ${step} reported no cost; the ${maxCostUsd} USD cost budget counts reported cost only`,
          )
        }
        const spent = usage?.reportedCost?.amount
        if (calls.length > 0 && spent !== undefined && spent >= maxCostUsd) {
          messages.push({ role: "tool", results: calls.map((c) => notRun(c.id)) })
          log(`reached cost budget (${maxCostUsd} USD, ${spent} reported) after step ${step}`)
          events.emit({ type: "run.budget_exhausted", kind: "cost", step })
          const accumulated = lastAssistantText || "(no output before the run was stopped)"
          const text = `${accumulated}\n\n[run stopped: cost budget of ${maxCostUsd} USD reached]`
          return result(text, "cost_exhausted", "cost_exhausted")
        }
      }

      if (calls.length === 0) {
        finalText = turn.text
        // A prose answer the output cap cut short. The run still completes,
        // but `stopReason: "length"` tells the caller not to apply the text
        // as if it were whole.
        cutOff = turn.finishReason === "length"
        break
      }

      // Everything one call goes through, from the stop check to its closing
      // event, in one place: the serial and the parallel path both run each
      // call through here, so no check can apply to one and not the other.
      // No result means the call was parked; a terminal call that succeeded
      // also hands back its answer.
      const dispatchCall = async (
        call: ToolCall,
      ): Promise<{ result?: ToolResult; terminal?: TerminalCall }> => {
        // Never START a tool once the run is stopping: a side effect begun
        // after a cancel is the one thing a cancel must prevent. The call is
        // answered as not run rather than skipped, so the turn still closes.
        // Checked when the call starts, so a call queued behind a parallel
        // batch is caught too.
        if (signal.aborted) return { result: notRun(call.id) }
        const tool = byName.get(call.name)
        if (!tool) {
          log(`tool ${call.name} (unknown)`)
          events.emit({
            type: "tool.failed",
            step,
            callId: call.id,
            name: call.name,
            reason: "unknown_tool",
            error: `unknown tool: ${call.name}`,
          })
          return {
            result: { toolCallId: call.id, content: `unknown tool: ${call.name}`, isError: true },
          }
        }
        // A call the output cap cut off is never run and never an answer. A
        // terminal call on a `length` turn is refused even when its arguments
        // parsed: the turn was cut, so the answer cannot be trusted whole. On
        // a `length` turn any other call runs only when its raw arguments are
        // present and parse (proof it was whole); a dialect that delivers no
        // raw text (Anthropic) cannot give that proof, so its calls on a cut
        // turn are refused too. On a whole turn, only arguments that do not
        // parse are refused, since running `{}` would be running something the
        // model did not say. The model is told, and answers again within its
        // budgets.
        const cut = turn.finishReason === "length"
        const refusal =
          cut && toolDispatch(tool) === "terminal"
            ? "answer cut off at the output token limit; it was not accepted. Answer again, more briefly."
            : (cut && call.argumentsText === undefined) || isTruncatedCall(call, turn.finishReason)
              ? "tool call arguments were cut off at the output token limit and did not parse; " +
                "the call was not run. Call again, more briefly."
              : undefined
        if (refusal !== undefined) {
          log(`tool ${call.name} refused: truncated`)
          events.emit({
            type: "tool.failed",
            step,
            callId: call.id,
            name: call.name,
            reason: "truncated",
            error: refusal,
          })
          return { result: { toolCallId: call.id, content: refusal, isError: true } }
        }
        // A whole call that does not fit its tool's schema, on a run that asked
        // for the check. Refused like a cut-off call, before it can run or park:
        // the model is told what to fix and answers again within its budgets,
        // and no retry is the loop's. A terminal call refused here is no answer.
        const invalid = req.validateToolInput ? invalidInputRefusal(tool, call.input) : undefined
        if (invalid !== undefined) {
          log(`tool ${call.name} refused: invalid input`)
          events.emit({
            type: "tool.failed",
            step,
            callId: call.id,
            name: call.name,
            reason: "invalid_input",
            error: invalid,
          })
          return { result: { toolCallId: call.id, content: invalid, isError: true } }
        }
        // An external tool is the caller's to run. The call is parked, not
        // executed, and the run ends `suspended` once this step's server-side
        // calls have run — so a mixed step executes what it can now and parks
        // only what it must. The whole call is kept (`argumentsText` included):
        // what resumes must be what was parked.
        if (toolDispatch(tool) === "external") {
          // Marked on the transcript's own copy of the call, so the resumed run
          // can tell a parked call from one that ran, whatever tools it has.
          call.external = true
          pending.push(call)
          log(`tool ${call.name} pending: dispatched externally`)
          events.emit({
            type: "tool.pending",
            step,
            callId: call.id,
            name: call.name,
            input: detach(call.input),
          })
          return {}
        }
        // Emitted BEFORE execution: a process that dies mid-tool still leaves
        // evidence that the effect may have started, which is the one case a
        // rollback consumer cannot afford to infer from silence.
        events.emit({
          type: "tool.called",
          step,
          callId: call.id,
          name: call.name,
          input: detach(call.input),
          ...undoFields(tool.meta),
        })
        try {
          // Uses the tool's structured executor when it has one, so a typed
          // payload survives alongside the string the model sees. Tools without
          // one take the original string path unchanged.
          // The tool gets its own copy; `call.input` stays the model's words.
          const output = await executeTool(tool, detach(call.input), {
            signal,
            callId: call.id,
            ...(loopCtx.runId !== undefined ? { runId: loopCtx.runId } : {}),
          })
          const result: ToolResult = {
            toolCallId: call.id,
            content: truncate(output.content),
            ...(output.structured !== undefined ? { structured: output.structured } : {}),
          }
          log(`tool ${call.name} ok (${output.content.length} bytes)`)
          // Reversibility is copied from the tool's own metadata at call time —
          // the tool set can differ per run, so a consumer reading the stream
          // later must not have to reconstruct which registry was in play.
          events.emit({
            type: "tool.succeeded",
            step,
            callId: call.id,
            name: call.name,
            bytes: Buffer.byteLength(output.content, "utf8"),
            ...undoFields(tool.meta),
          })
          // A terminal tool that returned is the run's answer. Its executor
          // ran like any other (a throw above is an ordinary tool error the
          // model gets to correct), and the rest of this turn's calls still
          // get their results so the transcript stays whole.
          if (toolDispatch(tool) === "terminal") {
            return {
              result,
              terminal: { callId: call.id, name: call.name, input: call.input, output },
            }
          }
          return { result }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log(`tool ${call.name} error: ${message}`)
          // Recorded even when the run is stopping: `tool.called` is already in
          // the stream, and a call with no closing event looks like a crash.
          events.emit({
            type: "tool.failed",
            step,
            callId: call.id,
            name: call.name,
            // A tool stopped by the run's cancel/deadline did not break.
            // Only when the error IS the stop, not a failure that coincided with it.
            reason: isAbortError(err, signal) ? "aborted" : "threw",
            error: message,
          })
          return { result: { toolCallId: call.id, content: message, isError: true } }
        }
      }

      // In series unless the run opted in; either way the results come back
      // in the model's order, and so does the choice of answer: the first
      // terminal call the model issued that succeeded, not the first to finish.
      const results: ToolResult[] = []
      for (const outcome of await runInSegments(calls, dispatchCall, segments)) {
        if (outcome.result) results.push(outcome.result)
        if (!terminal && outcome.terminal) terminal = outcome.terminal
      }
      if (pending.length > 0) {
        // A parked call outlives this run only when the run is actually
        // suspending. A stop or a terminal answer in the same step ends the
        // run instead, and the parked calls are answered as not run so the
        // transcript it leaves is whole and resumable.
        // Each parked call already has a `tool.pending` in the stream, and no
        // resumed run will come to close it, so it is closed here as
        // `aborted`: nothing ran, and the run moved on without it.
        if (signal.aborted) {
          for (const call of pending) {
            results.push(notRun(call.id))
            closePending(call, "the run was stopped before the caller could answer it")
          }
          pending = []
        } else if (terminal) {
          for (const call of pending) {
            results.push(notAnswered(call.id, "the run ended with a terminal answer"))
            closePending(call, "the run ended with a terminal answer")
          }
          pending = []
        } else {
          if (results.length > 0) messages.push({ role: "tool", results })
          log(`suspended with ${pending.length} pending external call(s)`)
          return result(turn.text, "suspended", "suspended")
        }
      }
      messages.push({ role: "tool", results })

      // A tool that ignored its signal can still return after the stop. Its
      // result is kept (the transcript stays whole), but the outcome is the
      // stop's — a terminal call that landed after a cancel is not an answer
      // the caller asked for, so it is not reported as one.
      if (signal.aborted) return stopped()

      // Checked before the step budget, so an answer given on the last allowed
      // step is still `completed` rather than `steps_exhausted`.
      if (terminal) {
        log(`terminal tool ${terminal.name} answered; ending the run`)
        finalText = turn.text
        break
      }

      if (step === maxSteps - 1) {
        exhausted = true
        events.emit({ type: "run.budget_exhausted", kind: "steps", step })
      }
    }
  } catch (err) {
    // Only an error that IS the abort (its reason, an SDK abort error, or
    // `throwIfAborted` above) is a clean stop. A real failure that merely
    // coincides with the abort propagates untouched, and `runWithEvents`
    // closes the stream around it as `failed`.
    if (isAbortError(err, signal)) return stopped()
    throw err
  }

  // A terminal tool answered: the prose is whatever the turn said (often
  // nothing), and the structured answer rides on `terminal`. No placeholder
  // text — an empty string is the honest value here.
  if (terminal) return result(finalText, "completed", "terminal_tool")

  // Ran out of time mid-loop: don't spend more of the (already-blown) budget on
  // a summary call — just return whatever prose we accumulated, clearly noted.
  if (!finalText && timedOut) {
    const accumulated = lastAssistantText || "(no output before time budget exhausted)"
    const text = `${accumulated}\n\n[run stopped: wall-clock budget of ${maxDurationMs}ms exceeded]`
    return result(text, "timed_out", "timed_out")
  }

  // Hit the step budget mid-tool-use: ask once more with no tools so the model
  // can summarize, falling back to its last prose rather than losing the work.
  if (!finalText && exhausted) {
    log(`reached max steps (${maxSteps}); requesting a final summary`)
    // A run stopped while the last tools ran gets no summary call: the caller
    // asked it to stop, or its time is already gone.
    if (signal.aborted) return stopped()
    try {
      const summaryResult = await model.invoke(request([]), ctx)
      const summary = summaryResult.value
      usage = addUsage(usage, summaryResult.usage)
      servedModel = summary.model
      servedUpstream = summary.upstream
      if (summary.responseId) responseIds.push(summary.responseId)
      lastFinish = summary.finishReason
      // Emitted like any other turn: `run.finished.text` can come from this
      // call, and a terminal event whose text traces back to no turn in the
      // transcript would break the stream's one promise.
      events.emit({
        type: "model.turn",
        step: stepsTaken,
        text: summary.text,
        toolCalls: [],
        ...(summaryResult.usage ? { usage: summaryResult.usage } : {}),
        ...(summary.model ? { model: summary.model } : {}),
        ...(summary.responseId ? { responseId: summary.responseId } : {}),
        ...(summary.upstream ? { upstream: summary.upstream } : {}),
        ...(summary.finishReason ? { finishReason: summary.finishReason } : {}),
      })
      // The summary is part of the conversation too: a caller that stores
      // `messages` and resumes later should see what the model last said.
      messages.push({ role: "assistant", text: summary.text, toolCalls: [] })
      finalText = summary.text || lastAssistantText
      // Same rule as a turn: a summary that arrives after the stop is kept,
      // but the run still ends with the stop's outcome.
      if (signal.aborted) {
        if (summary.text) lastAssistantText = summary.text
        return stopped()
      }
    } catch (err) {
      // Stopped during the summary itself: that is a cancel or a timeout, not
      // a summary that failed and was absorbed.
      if (isAbortError(err, signal)) return stopped()
      const error = err instanceof Error ? err.message : String(err)
      log(`final summary failed: ${error}`)
      // The stream must not be quieter than the log: without this, a
      // `run.finished` whose text fell back to an earlier turn would look
      // exactly like one whose summary succeeded.
      events.emit({ type: "model.turn.failed", step: stepsTaken, phase: "summary", error })
      finalText = lastAssistantText
    }
  }

  const text = finalText || "(no output)"
  // `completed` means the model stopped calling tools of its own accord. A run
  // that hit the step budget and was asked for a summary still reports
  // `steps_exhausted`, because the distinction is exactly what a consumer needs
  // to know about the trustworthiness of the answer.
  const outcome: RunOutcome = timedOut ? "timed_out" : exhausted ? "steps_exhausted" : "completed"
  const stopReason: StopReason = timedOut
    ? "timed_out"
    : exhausted
      ? "steps_exhausted"
      : cutOff
        ? "length"
        : "end_turn"
  // `runWithEvents` builds the terminal event from exactly this result, so the
  // return value and the stream cannot disagree — there is one source now, not
  // two that happen to be written from the same variables.
  return result(text, outcome, stopReason)
}
