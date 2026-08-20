import {
  runEventEmitter,
  type RunEventSink,
  type RunOutcome,
  type ToolSucceededEvent,
} from "./events.js"
import {
  nativeLoop,
  runWithEvents,
  type LoopContext,
  type LoopRequest,
  type LoopResult,
} from "./loop.js"
import { asChatModel, type ChatModel } from "./models/chat.js"
import type { InvokeContext } from "./models/types.js"
import type { AgentMessage, Provider, ToolResult } from "./providers/types.js"
import { executeTool, type Tool } from "./tools/registry.js"
import { toToolSpecs, type ToolMetadata } from "./tools/metadata.js"

export interface RunAgentOptions {
  /**
   * The chat model driving the loop. A bare {@link Provider} is accepted and
   * adapted onto the model seam internally, so existing callers are unaffected;
   * pass a {@link ChatModel} to drive the loop through a registry-resolved,
   * middleware-wrapped invocation instead.
   */
  provider: Provider | ChatModel
  system: string
  userPrompt: string
  tools: Tool[]
  maxSteps?: number
  /**
   * Wall-clock budget for the whole loop in ms. Checked between steps; when
   * exceeded the loop stops cleanly and returns what's accumulated (with a note)
   * rather than throwing. Defaults to `RUNNER_RUN_TIMEOUT_MS` if set, else 10min.
   */
  maxDurationMs?: number
  log?: (line: string) => void
  /**
   * Structured event sink. Absent (the default) means the loop behaves exactly
   * as it did before events existed — `log` is unaffected either way, and the
   * return value is unchanged. See `events.ts` for why the kernel emits this
   * stream but never stores it.
   */
  emit?: RunEventSink
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
 * kernel ships. `runAgent` and `NativeEngine` both come here.
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
): Partial<Pick<ToolSucceededEvent, "reversible" | "undoToolName" | "undoWindowSeconds">> {
  return {
    ...(meta?.reversible !== undefined ? { reversible: meta.reversible } : {}),
    ...(meta?.undoToolName !== undefined ? { undoToolName: meta.undoToolName } : {}),
    ...(meta?.undoWindowSeconds !== undefined ? { undoWindowSeconds: meta.undoWindowSeconds } : {}),
  }
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

function truncate(text: string, max = maxToolResultBytes()): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]`
}

/**
 * Drives a provider-agnostic tool-use loop: the model converses, the runner
 * executes any requested tools in the sandbox, feeds the results back, and
 * repeats until the model stops calling tools (or the step budget is hit). The
 * model orchestrates; deterministic work happens in the tools.
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
  // A `Provider` is adapted onto the model seam; a `ChatModel` passes straight
  // through. Either way the loop talks to one interface, so a
  // middleware-wrapped or registry-resolved model drives it identically.
  const log = options.log ?? (() => {})
  const result = await runWithEvents(
    nativeLoop,
    {
      model: asChatModel(options.provider),
      system: options.system,
      userPrompt: options.userPrompt,
      tools: options.tools,
      limits: resolveLoopLimits(options),
    },
    { log, events: runEventEmitter(options.emit, log) },
  )
  return result.text
}

/**
 * The native tool-use loop, as a {@link Loop}.
 *
 * Exported for `loop.ts` to wrap; applications reach it through `nativeLoop`
 * rather than calling this directly. It is the whole of the kernel's control
 * flow, and the only place any of it lives — `runAgent` and `nativeLoop` both
 * come here, so the two cannot drift.
 */
export async function runNativeLoop(req: LoopRequest, loopCtx: LoopContext): Promise<LoopResult> {
  const { model, system, userPrompt, tools } = req
  const { maxSteps, maxDurationMs } = req.limits
  const log = loopCtx.log

  const ctx: InvokeContext = { log, budget: { maxDurationMs } }
  // The emitter is the caller's: `seq` is per RUN, not per loop, so a loop that
  // made its own would restart the numbering mid-stream.
  const events = loopCtx.events

  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  const specs = toToolSpecs(tools)
  const messages: AgentMessage[] = [{ role: "user", text: userPrompt }]

  const deadline = Date.now() + maxDurationMs
  let finalText = ""
  let lastAssistantText = ""
  let exhausted = false
  let timedOut = false
  let stepsTaken = 0

  // A throw propagates untouched; `runWithEvents` closes the stream around it,
  // so every loop gets that property rather than only this one.
  for (let step = 0; step < maxSteps; step += 1) {
    // Wall-clock budget: enforced between steps so an in-flight provider/tool
    // call isn't interrupted mid-flight, mirroring how maxSteps stops cleanly.
    // Because the check is only between steps, a single step can overshoot the
    // budget by its entire duration: up to (provider timeout × maxRetries) for the
    // converse call plus the time to execute all of that step's tool calls. So the
    // effective ceiling is `maxDurationMs + one full step`, not `maxDurationMs`.
    if (Date.now() >= deadline) {
      timedOut = true
      log(`reached run time budget (${maxDurationMs}ms) after ${step} step(s)`)
      events.emit({ type: "run.budget_exhausted", kind: "duration", step })
      break
    }
    const { value: turn } = await model.invoke({ system, messages, tools: specs }, ctx)
    stepsTaken = step + 1
    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls })
    if (turn.text) lastAssistantText = turn.text
    events.emit({
      type: "model.turn",
      step,
      text: turn.text,
      toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name })),
    })

    if (turn.toolCalls.length === 0) {
      finalText = turn.text
      break
    }

    const results: ToolResult[] = []
    for (const call of turn.toolCalls) {
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
        const output = await executeTool(tool, call.input)
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ toolCallId: call.id, content: message, isError: true })
        log(`tool ${call.name} error: ${message}`)
        events.emit({
          type: "tool.failed",
          step,
          callId: call.id,
          name: call.name,
          reason: "threw",
          error: message,
        })
      }
    }
    messages.push({ role: "tool", results })

    if (step === maxSteps - 1) {
      exhausted = true
      events.emit({ type: "run.budget_exhausted", kind: "steps", step })
    }
  }

  // Ran out of time mid-loop: don't spend more of the (already-blown) budget on
  // a summary call — just return whatever prose we accumulated, clearly noted.
  if (!finalText && timedOut) {
    const accumulated = lastAssistantText || "(no output before time budget exhausted)"
    const text = `${accumulated}\n\n[run stopped: wall-clock budget of ${maxDurationMs}ms exceeded]`
    return { text, steps: stepsTaken, outcome: "timed_out" }
  }

  // Hit the step budget mid-tool-use: ask once more with no tools so the model
  // can summarize, falling back to its last prose rather than losing the work.
  if (!finalText && exhausted) {
    log(`reached max steps (${maxSteps}); requesting a final summary`)
    try {
      const summary = (await model.invoke({ system, messages, tools: [] }, ctx)).value
      // Emitted like any other turn: `run.finished.text` can come from this
      // call, and a terminal event whose text traces back to no turn in the
      // transcript would break the stream's one promise.
      events.emit({ type: "model.turn", step: stepsTaken, text: summary.text, toolCalls: [] })
      finalText = summary.text || lastAssistantText
    } catch (err) {
      log(`final summary failed: ${err instanceof Error ? err.message : String(err)}`)
      finalText = lastAssistantText
    }
  }

  const text = finalText || "(no output)"
  // `completed` means the model stopped calling tools of its own accord. A run
  // that hit the step budget and was asked for a summary still reports
  // `steps_exhausted`, because the distinction is exactly what a consumer needs
  // to know about the trustworthiness of the answer.
  const outcome: RunOutcome = timedOut ? "timed_out" : exhausted ? "steps_exhausted" : "completed"
  // `runWithEvents` builds the terminal event from exactly this result, so the
  // return value and the stream cannot disagree — there is one source now, not
  // two that happen to be written from the same variables.
  return { text, steps: stepsTaken, outcome }
}
