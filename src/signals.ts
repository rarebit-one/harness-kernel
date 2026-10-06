/**
 * Internal helpers for the run's cancellation signals: a caller's cancel and a
 * wall-clock deadline, merged into one signal whose `reason` still says which
 * of the two fired. Not exported from `index.ts`.
 */

import type { RunOutcome } from "./events.js"

/** Node's timers cap at 2^31-1 ms; a longer delay would fire after 1ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * A signal that fires when a wall-clock budget runs out. Clamped to what a
 * timer can represent, so an "effectively unlimited" budget stays unlimited
 * rather than overflowing into an immediate abort, and a negative one fires at
 * once.
 */
export function deadlineSignal(maxDurationMs: number): AbortSignal {
  const ms = Number.isFinite(maxDurationMs)
    ? Math.min(Math.max(0, Math.ceil(maxDurationMs)), MAX_TIMER_MS)
    : MAX_TIMER_MS
  return AbortSignal.timeout(ms)
}

/**
 * Map an external harness's ending onto the run outcome vocabulary: its own
 * timer → `timed_out`, the caller's signal → `canceled`, otherwise the
 * harness's error flag decides between `failed` and `completed`.
 */
export function harnessOutcome(isError: boolean, stoppedBy?: StoppedBy): RunOutcome {
  if (stoppedBy === "deadline") return "timed_out"
  if (stoppedBy === "signal") return "canceled"
  return isError ? "failed" : "completed"
}

/**
 * True when `err` is the run's abort surfacing, not an unrelated failure that
 * merely happened after it. Requires the signal to have fired, and the error to
 * be its reason, to carry it as `cause` (how `run_code` and `http_fetch` wrap
 * it), or to be one of the abort errors the platform and the provider SDKs
 * raise (`AbortError`, `TimeoutError`, the Anthropic/OpenAI SDKs'
 * `APIUserAbortError`, matched by name or class name).
 */
export function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false
  if (err === signal.reason) return true
  if (!(err instanceof Error)) return false
  if (err.cause !== undefined && err.cause === signal.reason) return true
  return ABORT_ERROR_NAMES.has(err.name) || ABORT_ERROR_NAMES.has(err.constructor.name)
}

const ABORT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "APIUserAbortError"])

/** What stopped a run early: its own deadline, or the caller's signal. */
export type StoppedBy = "deadline" | "signal"

/** A run's merged stop signal, plus which source fired. */
export interface RunStop {
  /** Fires on the deadline or the caller's abort; absent when neither exists. */
  signal?: AbortSignal
  /** Which source fired, or `undefined` while the run has not been stopped. */
  stoppedBy(): StoppedBy | undefined
}

/**
 * Merge an optional wall-clock budget with an optional caller signal.
 *
 * `AbortSignal.any` carries the first source's `reason` through by identity,
 * so comparing it against the deadline's own reason tells a timeout from a
 * cancel without a second flag that could drift from the signal.
 */
export function runStop(maxDurationMs: number | undefined, external?: AbortSignal): RunStop {
  const deadline =
    maxDurationMs !== undefined && maxDurationMs > 0 ? deadlineSignal(maxDurationMs) : undefined
  const sources = [deadline, external].filter((s): s is AbortSignal => s !== undefined)
  const signal = sources.length > 1 ? AbortSignal.any(sources) : sources[0]
  return {
    ...(signal ? { signal } : {}),
    stoppedBy: () => {
      if (!signal?.aborted) return undefined
      return deadline !== undefined && signal.reason === deadline.reason ? "deadline" : "signal"
    },
  }
}
