/**
 * The run event stream: a structured, ordered record of what happened inside a
 * run, alongside the human-readable `log` line callback that predates it.
 *
 * **The kernel EMITS the stream; it never STORES it.** There is no session
 * store, no resume, no fork and no replay in here — those need persistence and
 * a schema, which is exactly the infrastructure a kernel must not ship. What
 * the kernel owes an application is a faithful, ordered, machine-readable
 * account of the run; what the application does with it (append to a log,
 * project into a UI, compute a rollback plan) is policy and lives above.
 *
 * This is the same split the rest of the kernel already makes: `ToolMetadata`
 * declares that a tool is `reversible` without implementing undo, and
 * `requiresConfirmation` without implementing a confirmation flow. The events
 * here are the missing half of that bargain — the metadata says a tool *can* be
 * undone, and the stream is what records that it *was called*, so an
 * application has something concrete to undo.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   - **Ordered.** Every event carries a monotonic `seq` from a single counter
 *     per run. A consumer that receives events out of band can still sort them,
 *     and a gap in the sequence is detectable — a dropped event is not allowed
 *     to look like an event that never happened.
 *   - **Non-fatal.** A sink that throws is reported through `log` and skipped;
 *     it never fails the run. Observability that can take production down is
 *     worse than no observability, and the kernel already applies this rule to
 *     context providers.
 */

import type { Usage } from "./models/types.js"

/** Every event kind the loop emits. */
export type RunEventType =
  | "run.started"
  | "model.turn"
  | "model.turn.failed"
  | "tool.called"
  | "tool.succeeded"
  | "tool.failed"
  | "run.budget_exhausted"
  | "run.finished"

/**
 * Fields common to every event.
 *
 * `seq` is per-run and starts at 0. `at` is epoch milliseconds rather than a
 * formatted string: a consumer that wants a locale-formatted timestamp can make
 * one, but a consumer handed a formatted string cannot reliably get the instant
 * back.
 */
export interface RunEventBase {
  seq: number
  at: number
  /**
   * Set on every event of a private run (`RunSpec.private`): its content fields
   * (model text, tool arguments, error messages, final text) were withheld. Lets
   * a consumer tell an empty field from a redacted one. Absent otherwise.
   */
  redacted?: true
}

/**
 * Why a run stopped. `failed` means the loop threw — the error propagates to
 * the caller unchanged, but the stream is closed first so a persistent
 * consumer can tell a crashed run from one that is still going.
 *
 * `canceled` means the CALLER aborted the run through its `signal`; it is kept
 * apart from `timed_out` (the run's own wall-clock budget ran out) because the
 * two call for different responses — one was asked for, the other was not. In
 * the native loop both are clean stops that return the accumulated prose, never
 * a throw.
 */
export type RunOutcome = "completed" | "steps_exhausted" | "timed_out" | "canceled" | "failed"

/**
 * Whether a tool's effect is safe to execute again after an interruption,
 * copied from `ToolMetadata.replay`. Absent means the tool made no claim, which
 * a resuming consumer must treat as `unsafe`.
 */
export type ToolReplay = "safe" | "unsafe"

/** Which budget ran out. */
export type BudgetKind = "steps" | "duration"

/** The loop is about to take its first turn. Carries the resolved budgets and
 *  the tool surface actually handed to the model — which is the projected
 *  surface, after metadata scoping, not everything the caller passed in. */
export interface RunStartedEvent extends RunEventBase {
  type: "run.started"
  maxSteps: number
  maxDurationMs: number
  tools: string[]
}

/** One assistant turn: its prose and the tool calls it requested. */
export interface ModelTurnEvent extends RunEventBase {
  type: "model.turn"
  step: number
  text: string
  toolCalls: { id: string; name: string }[]
  /** What the turn cost, when the model reported it (`ModelResult.usage`).
   *  Absent means "not reported", never "free". */
  usage?: Usage
}

/**
 * A model invocation failed and the loop **absorbed** it: the run carries on
 * and will still close with its normal outcome. A model failure that is NOT
 * absorbed propagates instead, and is recorded by `run.finished` with
 * `outcome: "failed"` — so this event never precedes a crash, and a consumer
 * never sees the same failure twice.
 *
 * Today the one absorbed call is the tools-free wrap-up the loop makes after
 * the step budget runs out (`phase: "summary"`); on failure the run falls back
 * to the last assistant prose. `phase` is there so that one emitter is explicit
 * rather than implied, and so a future soft-failing call names itself instead
 * of overloading this one. Without the event, the stream would be quieter than
 * `log` in the one place they must agree: a `run.finished` whose text came from
 * an earlier turn would be indistinguishable from a summary that succeeded.
 */
export interface ModelTurnFailedEvent extends RunEventBase {
  type: "model.turn.failed"
  step: number
  phase: "summary"
  error: string
}

/**
 * A tool is about to execute. Emitted before the call so a crash mid-tool still
 * leaves evidence that the effect may have started — which is precisely the
 * case a rollback consumer must not miss.
 *
 * It carries the same reversibility fields as {@link ToolSucceededEvent}, and
 * that duplication is the point: a tool that half-applies its effect and then
 * throws produces `tool.called` + `tool.failed`, so if undo metadata appeared
 * only on success the one case this event exists for would be the one case a
 * consumer could not act on.
 *
 * `input` is a detached copy, never the object handed to the tool — see the
 * note in the loop. **It is also the raw tool arguments**: anything a model
 * passed as an argument, including a secret or PII it was given, now reaches
 * every attached sink. Nothing outside the model conversation captured these
 * before, so a sink that persists or forwards events is a new place for that
 * data to land and should redact accordingly.
 */
export interface ToolCalledEvent extends RunEventBase {
  type: "tool.called"
  step: number
  callId: string
  name: string
  input: Record<string, unknown>
  reversible?: boolean
  undoToolName?: string | null
  undoWindowSeconds?: number | null
  /** The tool's declared `ToolMetadata.replay`, copied at call time. */
  replay?: ToolReplay
}

/**
 * A tool executed successfully.
 *
 * The reversibility fields are copied from the tool's own {@link ToolMetadata}
 * at call time, not looked up later: the tool set can differ between runs and
 * between steps, so a consumer reading the stream after the fact must not have
 * to reconstruct which registry was in play. `reversible` absent means the tool
 * declared nothing, which per the metadata contract means "no restriction" —
 * and here specifically means "makes no claim", never "safe to undo".
 */
export interface ToolSucceededEvent extends RunEventBase {
  type: "tool.succeeded"
  step: number
  callId: string
  name: string
  /** UTF-8 byte length of the model-facing string, before truncation. Bytes
   *  rather than `String.length`, which counts UTF-16 code units and
   *  under-reports anything outside the BMP. */
  bytes: number
  reversible?: boolean
  undoToolName?: string | null
  undoWindowSeconds?: number | null
  /** The tool's declared `ToolMetadata.replay`, copied at call time. */
  replay?: ToolReplay
}

/** A tool call did not produce a result. `unknown_tool` is separated from
 *  `threw` because they mean different things to a consumer: one is a model
 *  hallucinating a name, the other is a real effect that may have partially
 *  landed. `aborted` is a tool stopped by the run's cancel or deadline — its
 *  effect may also have partially landed, but the tool did not fail. */
export interface ToolFailedEvent extends RunEventBase {
  type: "tool.failed"
  step: number
  callId: string
  name: string
  reason: "threw" | "unknown_tool" | "aborted"
  error: string
}

/** A budget was exhausted. Emitted at the moment the loop notices, which for
 *  `duration` is between steps — see the overshoot note on the loop itself. */
export interface RunBudgetExhaustedEvent extends RunEventBase {
  type: "run.budget_exhausted"
  kind: BudgetKind
  step: number
}

/**
 * The run is over. Always the last event, whatever the outcome — including when
 * the loop throws, in which case it is emitted before the error propagates.
 *
 * `steps` and `text` are optional because on the failure path they are genuinely
 * unknown: the loop threw and never returned a result, so any number here would
 * be **invented**. They are omitted rather than zeroed — a wrong number is worse
 * than an absent one, and the `model.turn` events already in the stream are the
 * authoritative record of how far the run got. On every other outcome both are
 * present.
 */
export interface RunFinishedEvent extends RunEventBase {
  type: "run.finished"
  outcome: RunOutcome
  steps?: number
  text?: string
  /** Present when `outcome` is `failed`, and when a loop THREW on a caller
   *  abort (`canceled` with the error that loop raised). */
  error?: string
}

export type RunEvent =
  | RunStartedEvent
  | ModelTurnEvent
  | ModelTurnFailedEvent
  | ToolCalledEvent
  | ToolSucceededEvent
  | ToolFailedEvent
  | RunBudgetExhaustedEvent
  | RunFinishedEvent

/** Where events go. Synchronous and returning void on purpose: a sink that
 *  needs to do I/O should buffer and flush on its own schedule rather than make
 *  the loop await it. */
export type RunEventSink = (event: RunEvent) => void

/** The per-event fields a caller supplies; `seq` and `at` are the emitter's. */
export type RunEventInput =
  | Omit<RunStartedEvent, keyof RunEventBase>
  | Omit<ModelTurnEvent, keyof RunEventBase>
  | Omit<ModelTurnFailedEvent, keyof RunEventBase>
  | Omit<ToolCalledEvent, keyof RunEventBase>
  | Omit<ToolSucceededEvent, keyof RunEventBase>
  | Omit<ToolFailedEvent, keyof RunEventBase>
  | Omit<RunBudgetExhaustedEvent, keyof RunEventBase>
  | Omit<RunFinishedEvent, keyof RunEventBase>

/**
 * The events a {@link Loop} may emit: everything except the bookends.
 *
 * `run.started` and `run.finished` belong to `runWithEvents`, which brackets
 * whichever loop runs. A loop that emitted its own would produce a duplicate
 * start, or a premature terminal event that a consumer stops reading at — and
 * a loop migrated from the older API, where loops DID own their stream, is
 * exactly the code that would try. Excluding them from the type means that
 * migration fails to compile instead of producing a subtly wrong stream.
 */
export type LoopEventInput = Exclude<
  RunEventInput,
  { type: "run.started" } | { type: "run.finished" }
>

/** Stamps `seq`/`at` and delivers to a sink, isolating sink failures. */
export interface LoopEventEmitter {
  emit(event: LoopEventInput): void
  readonly count: number
}

export interface RunEventEmitter {
  emit(event: RunEventInput): void
  /** How many events have been stamped. Lets a caller close a run with the
   *  step/event count without threading a second counter through the loop. */
  readonly count: number
}

/**
 * Build an emitter over an optional sink.
 *
 * With no sink this is a functioning no-op — the counter still advances, so
 * turning the sink on later cannot change the sequence numbering. Callers
 * therefore never branch on whether events are wanted.
 */
export function runEventEmitter(
  sink?: RunEventSink,
  log: (line: string) => void = () => {},
): RunEventEmitter {
  let seq = 0
  return {
    emit(event: RunEventInput): void {
      const stamped: RunEvent = { ...event, seq: seq++, at: Date.now() }
      if (!sink) return
      try {
        sink(stamped)
      } catch (err) {
        // Never fail a run because its observability failed.
        log(
          `event sink threw on ${stamped.type}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    get count(): number {
      return seq
    },
  }
}

/**
 * An in-memory append-only recorder — the smallest possible session log, and
 * the reference shape for a persistent one.
 *
 * Provided because a caller should not have to write an array-push to test that
 * a run emitted what it should. It is explicitly NOT a session store: it has no
 * persistence, no identity and no bound on growth.
 */
export function recordRunEvents(): { sink: RunEventSink; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { sink: (event) => void events.push(event), events }
}
