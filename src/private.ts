/**
 * Private runs: the run's observable channels carry phase codes only.
 *
 * A run marked `RunSpec.private` works on material its caller must not let out
 * of the host: the tool arguments, tool results and model prose of such a run
 * are the material itself. Everything else in the kernel assumes the opposite —
 * `log` lines quote tool errors and cancel reasons, and the event stream carries
 * raw tool arguments and every turn's text — so a private run cannot simply
 * reuse those channels and hope each sink redacts.
 *
 * Instead the channels are narrowed at the source. {@link privateRunChannels}
 * wraps a caller's `log` and event sink so that:
 *
 *   - **`log` receives no free text at all.** Every line the kernel (or a loop,
 *     a context provider, a connector) would have written is dropped, and one
 *     fixed-vocabulary phase line is written per event instead.
 *   - **Events keep their shape, `seq` and `at`, but lose their content.**
 *     Model text, tool arguments, error messages and the final text are
 *     removed; the event is marked `redacted: true` so a consumer can tell an
 *     empty field from a withheld one. A tool name the run did not register (a
 *     name the model made up, which is model output) is replaced as well, and
 *     every tool-call id (provider output) becomes a per-run `call-<n>`
 *     surrogate. Events are rebuilt from an allow-list of fields, so anything
 *     the kernel does not know about is dropped rather than forwarded.
 *
 * What survives is deliberately structural: event types, step numbers, the
 * registered tool names, outcomes, budgets, numeric usage and result sizes in
 * bytes. That is enough for a caller to show progress and account for cost, and
 * none of it is the run's material.
 *
 * The run's return value is NOT narrowed: `EngineResult.text` goes back to the
 * caller that started the run, which decides where (if anywhere) it is written.
 */

import type { RunEvent, RunEventSink } from "./events.js"
import type { TokenUsage, Usage } from "./models/types.js"

/** What every withheld string field is replaced with. */
export const PRIVATE_REDACTION = "[redacted]"

/** Stands in for a tool name the run never registered (model output). */
const UNREGISTERED_TOOL = "(unregistered)"

/**
 * Thrown by an engine in place of whatever a private run threw. The original
 * error's message can quote the run's material (a tool's error, a provider's
 * echo of the prompt), so it is not carried — not as the message and not as
 * `cause`, which error reporters walk and upload. Only the phase survives.
 */
export class PrivateRunError extends Error {
  /** Where the run failed: setting the run up, or inside the loop. */
  readonly phase: "setup" | "loop"

  constructor(phase: "setup" | "loop") {
    super(`private run failed during ${phase} (details withheld)`)
    this.name = "PrivateRunError"
    this.phase = phase
  }
}

/** The narrowed channels for one private run. */
export interface PrivateRunChannels {
  /** Drops every free-text line. Hand this to anything that would log. */
  log: (line: string) => void
  /**
   * Redacts each event, forwards it to the caller's sink (if any), and writes
   * its phase line to the caller's `log`. Always defined, so the phase lines
   * appear even when the caller attached no sink.
   */
  emit: RunEventSink
}

/**
 * Narrow a run's `log` and event sink for a private run. One instance per run:
 * it learns the registered tool names from that run's `run.started`.
 */
export function privateRunChannels(
  log: (line: string) => void,
  sink?: RunEventSink,
): PrivateRunChannels {
  let registered: Set<string> | undefined
  const toolName = (name: string): string => (registered?.has(name) ? name : UNREGISTERED_TOOL)

  // Tool-call ids come from the provider's output, so they are model output
  // too. Each is replaced by a surrogate assigned in first-seen order; the map
  // lives for the run, so a turn's call and its tool events still correlate.
  const surrogates = new Map<string, string>()
  const callId = (id: string): string => {
    let surrogate = surrogates.get(id)
    if (surrogate === undefined) {
      surrogate = `call-${surrogates.size + 1}`
      surrogates.set(id, surrogate)
    }
    return surrogate
  }

  // Each redacted event is REBUILT from an allow-list of fields rather than
  // spread from the original: a field the kernel does not know about (one a
  // custom loop added, say) is dropped, never forwarded. Enum-typed fields are
  // re-checked at runtime, since a custom loop's value is only as narrow as
  // its author's types.
  const base = (event: RunEvent): { seq: number; at: number; redacted: true } => ({
    seq: event.seq,
    at: event.at,
    redacted: true,
  })

  const redact = (event: RunEvent): RunEvent => {
    switch (event.type) {
      case "run.started":
        registered = new Set(event.tools)
        return {
          ...base(event),
          type: event.type,
          maxSteps: event.maxSteps,
          maxDurationMs: event.maxDurationMs,
          tools: [...event.tools],
        }
      case "model.turn": {
        const usage = redactUsage(event.usage)
        return {
          ...base(event),
          type: event.type,
          step: event.step,
          text: "",
          toolCalls: event.toolCalls.map((c) => ({ id: callId(c.id), name: toolName(c.name) })),
          ...(usage ? { usage } : {}),
        }
      }
      case "model.turn.failed":
        return {
          ...base(event),
          type: event.type,
          step: event.step,
          phase: "summary",
          error: PRIVATE_REDACTION,
        }
      case "tool.called":
        return {
          ...base(event),
          type: event.type,
          step: event.step,
          callId: callId(event.callId),
          name: toolName(event.name),
          input: {},
          ...undoFields(event),
        }
      case "tool.succeeded":
        return {
          ...base(event),
          type: event.type,
          step: event.step,
          callId: callId(event.callId),
          name: toolName(event.name),
          bytes: event.bytes,
          ...undoFields(event),
        }
      case "tool.failed":
        return {
          ...base(event),
          type: event.type,
          step: event.step,
          callId: callId(event.callId),
          name: toolName(event.name),
          reason: oneOf(event.reason, FAILURE_REASONS, "threw"),
          error: PRIVATE_REDACTION,
        }
      case "run.budget_exhausted":
        return {
          ...base(event),
          type: event.type,
          kind: oneOf(event.kind, BUDGET_KINDS, "steps"),
          step: event.step,
        }
      case "run.finished":
        // `text` is the run's final prose; dropped rather than blanked, the same
        // way the failure path omits it.
        return {
          ...base(event),
          type: event.type,
          outcome: oneOf(event.outcome, OUTCOMES, "failed"),
          ...(event.steps !== undefined ? { steps: event.steps } : {}),
          ...(event.error !== undefined ? { error: PRIVATE_REDACTION } : {}),
        }
    }
  }

  return {
    log: () => {},
    emit(event: RunEvent): void {
      const redacted = redact(event)
      log(phaseLine(redacted))
      sink?.(redacted)
    },
  }
}

const FAILURE_REASONS = ["threw", "unknown_tool", "aborted"] as const
const BUDGET_KINDS = ["steps", "duration"] as const
const OUTCOMES = ["completed", "steps_exhausted", "timed_out", "canceled", "failed"] as const

/** `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** Numbers only. A unit-usage `unit` label is provider-supplied text, so it goes. */
function redactUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined
  if ("units" in usage) return typeof usage.units === "number" ? { units: usage.units } : undefined
  const out: TokenUsage = {}
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const n = usage[key]
    if (typeof n === "number") out[key] = n
  }
  return out
}

/**
 * The reversibility fields, copied from the tool's own registered metadata
 * (application-supplied, never model output), each only when declared.
 */
function undoFields(event: {
  reversible?: boolean
  undoToolName?: string | null
  undoWindowSeconds?: number | null
  replay?: "safe" | "unsafe"
}): {
  reversible?: boolean
  undoToolName?: string | null
  undoWindowSeconds?: number | null
  replay?: "safe" | "unsafe"
} {
  return {
    ...(typeof event.reversible === "boolean" ? { reversible: event.reversible } : {}),
    ...(event.undoToolName !== undefined ? { undoToolName: event.undoToolName } : {}),
    ...(event.undoWindowSeconds !== undefined
      ? { undoWindowSeconds: event.undoWindowSeconds }
      : {}),
    ...(event.replay === "safe" || event.replay === "unsafe" ? { replay: event.replay } : {}),
  }
}

/** The one log line a redacted event becomes: fixed keys, structural values. */
function phaseLine(event: RunEvent): string {
  switch (event.type) {
    case "run.started":
      return `phase=${event.type} tools=${event.tools.length} max_steps=${event.maxSteps}`
    case "model.turn":
      return `phase=${event.type} step=${event.step} tool_calls=${event.toolCalls.length}`
    case "model.turn.failed":
      return `phase=${event.type} step=${event.step} during=${event.phase}`
    case "tool.called":
    case "tool.succeeded":
      return `phase=${event.type} step=${event.step} tool=${event.name}`
    case "tool.failed":
      return `phase=${event.type} step=${event.step} tool=${event.name} reason=${event.reason}`
    case "run.budget_exhausted":
      return `phase=${event.type} step=${event.step} kind=${event.kind}`
    case "run.finished":
      return `phase=${event.type} outcome=${event.outcome}${
        event.steps !== undefined ? ` steps=${event.steps}` : ""
      }`
  }
}

/**
 * The `supports()` refusal every out-of-process engine gives a private run.
 * Such an engine hands the run's material to a harness process the kernel does
 * not observe, so it cannot keep the private-run guarantees — and per the
 * fail-loud rule it refuses rather than running without them.
 */
export function refusePrivateRun(
  engine: string,
  spec: { private?: boolean | undefined },
): { ok: false; reason: string } | undefined {
  if (!spec.private) return undefined
  return {
    ok: false,
    reason: `${engine} engine cannot run a private run: only the in-process native engine keeps its material off the run's log and event channels`,
  }
}
