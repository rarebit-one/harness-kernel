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
  type LoopContext,
  type LoopRequest,
  type LoopResult,
  type TerminalCall,
} from "./loop.js"
import { asChatModel, chatRequest, type ChatModel } from "./models/chat.js"
import { deadlineSignal, isAbortError } from "./signals.js"
import type { InvokeContext, TokenUsage, Usage } from "./models/types.js"
import type { ProviderOptions } from "./providers/options.js"
import type { AgentMessage, Provider, ToolResult, ToolSpec } from "./providers/types.js"
import { executeTool, type Tool } from "./tools/registry.js"
import { toToolSpecs, toolDispatch, type ToolMetadata } from "./tools/metadata.js"

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
   * Cancels the run. On abort the in-flight model request and tool are
   * stopped, no summary call is made, and the run resolves (never rejects)
   * with the prose accumulated so far and `outcome: "canceled"`.
   */
  signal?: AbortSignal
  /** The run's id, handed to tools on `ToolContext.runId`. */
  runId?: string
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
}): { maxSteps: number; maxDurationMs: number } {
  return {
    maxSteps: limits?.maxSteps ?? DEFAULT_MAX_STEPS,
    maxDurationMs: limits?.maxDurationMs ?? defaultMaxDurationMs(),
  }
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
}

/** The finer reason a custom loop's bare outcome implies, when it reported none. */
function stopReasonFor(outcome: RunOutcome): StopReason {
  return outcome === "completed" ? "end_turn" : outcome
}

/**
 * Drives a provider-agnostic tool-use loop: the model converses, the runner
 * executes any requested tools in the sandbox, feeds the results back, and
 * repeats until the model stops calling tools (or the step budget is hit). The
 * model orchestrates; deterministic work happens in the tools.
 *
 * This is the single-shot form: one user prompt in, the final prose out. It is
 * {@link runConversation} with a one-message seed, kept because most callers
 * want exactly that and nothing more.
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
  const { userPrompt, ...rest } = options
  const result = await runConversation({
    ...rest,
    messages: [{ role: "user", text: userPrompt }],
  })
  return result.text
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
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.terminal ? { terminal: result.terminal } : {}),
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
  const { maxSteps, maxDurationMs } = req.limits
  const log = loopCtx.log

  // Both checks come before the first model call: a bad seed or a tool this
  // loop cannot dispatch is a configuration error, and the cheapest failure is
  // the one that spends no tokens.
  assertSeed(req.messages)
  const external = tools.filter((t) => toolDispatch(t) === "external").map((t) => t.spec.name)
  if (external.length > 0) {
    throw new Error(
      `tool(s) ${external.join(", ")} declare dispatch "external", which needs a loop that can ` +
        "suspend on a pending call and resume with its result; the native loop cannot yet",
    )
  }

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
  // The seed is the caller's. It is copied so the loop's appends never reach
  // the array it was handed: a service that kept the seed for its own records
  // must not find it grown.
  const messages: AgentMessage[] = [...req.messages]
  const request = (toolSpecs: ToolSpec[]) =>
    chatRequest(system, messages, toolSpecs, undefined, providerOptions)
  const provider = model.id

  const deadlineAt = Date.now() + maxDurationMs
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
  const responseIds: string[] = []

  /** Everything a result carries besides the three the caller decides per path. */
  const result = (text: string, outcome: RunOutcome, stopReason: StopReason): LoopResult => ({
    text,
    steps: stepsTaken,
    outcome,
    stopReason,
    messages,
    provider,
    responseIds,
    ...(servedModel !== undefined ? { model: servedModel } : {}),
    ...(servedUpstream !== undefined ? { upstream: servedUpstream } : {}),
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
      const turnResult = await model.invoke(request(specs), ctx)
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
      events.emit({
        type: "model.turn",
        step,
        text: turn.text,
        toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name })),
        ...(turnResult.usage ? { usage: turnResult.usage } : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.responseId ? { responseId: turn.responseId } : {}),
        ...(turn.upstream ? { upstream: turn.upstream } : {}),
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

      if (calls.length === 0) {
        finalText = turn.text
        break
      }

      const results: ToolResult[] = []
      for (const call of calls) {
        // Never START a tool once the run is stopping: a side effect begun
        // after a cancel is the one thing a cancel must prevent. The call is
        // answered as not run rather than skipped, so the turn still closes.
        if (signal.aborted) {
          results.push(notRun(call.id))
          continue
        }
        const tool = byName.get(call.name)
        if (!tool) {
          results.push({
            toolCallId: call.id,
            content: `unknown tool: ${call.name}`,
            isError: true,
          })
          log(`tool ${call.name} (unknown)`)
          events.emit({
            type: "tool.failed",
            step,
            callId: call.id,
            name: call.name,
            reason: "unknown_tool",
            error: `unknown tool: ${call.name}`,
          })
          continue
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
          results.push({
            toolCallId: call.id,
            content: truncate(output.content),
            ...(output.structured !== undefined ? { structured: output.structured } : {}),
          })
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
          if (!terminal && toolDispatch(tool) === "terminal") {
            terminal = { callId: call.id, name: call.name, input: call.input, output }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          results.push({ toolCallId: call.id, content: message, isError: true })
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
  const stopReason: StopReason = timedOut ? "timed_out" : exhausted ? "steps_exhausted" : "end_turn"
  // `runWithEvents` builds the terminal event from exactly this result, so the
  // return value and the stream cannot disagree — there is one source now, not
  // two that happen to be written from the same variables.
  return result(text, outcome, stopReason)
}
