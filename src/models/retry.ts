import {
  type Health,
  type InvokeContext,
  type ModelCaps,
  type ModelInvocation,
  type ModelResult,
  type StreamSink,
} from "./types.js"

/**
 * Retry and fallback around a model invocation, as an opt-in decorator.
 *
 * The kernel leaves transient failures to the vendor SDKs by default. A caller
 * that needs a policy those SDKs cannot express — a wait that knows the run's
 * deadline, an honoured `Retry-After`, a named chain of other models to try
 * once the primary is exhausted — wraps its model in {@link withRetry} and
 * turns the SDK's own retries off (`providerOptions.maxRetries: 0`), so the two
 * do not multiply.
 *
 * This is infrastructure, not a quality loop: an attempt is repeated only when
 * the call FAILED (threw), never because its answer was judged poor. And it is
 * explicit: there is no default fallback chain, so a call that ends up on
 * another model does so because the caller listed that model.
 *
 * It wraps a {@link ModelInvocation} rather than being a `Middleware`
 * because a fallback chain needs several invocations, and middleware is handed
 * exactly one `next`. Being payload-generic, it covers every kind the same way
 * middleware does: a chat model, a detector, a forecaster.
 */

/**
 * What to do after a failed attempt.
 *
 * - `retry` — a transient fault: try the same model again after a backoff, and
 *   move to the next model in the chain once its attempts run out.
 * - `fallback` — this model will not answer soon: skip its remaining attempts
 *   and move to the next model at once.
 * - `fatal` — a fault no other attempt can fix (a bad credential, an invalid
 *   request): rethrow it unchanged, trying nothing else.
 */
export type RetryDecision = "retry" | "fallback" | "fatal"

/** One model in the chain giving up, or one wait before trying it again. */
export type RetryEvent =
  | {
      type: "retry"
      /** The invocation id that failed and will be tried again. */
      model: string
      /** The attempt on this model that just failed, from 1. */
      attempt: number
      /** How long the wrapper waits before the next attempt. */
      delayMs: number
      /** True when `delayMs` came from the server's `Retry-After`. */
      retryAfter: boolean
      /** The failure. Absent when the wrapper was built with `private: true`. */
      error?: unknown
    }
  | {
      type: "fallback"
      /** The invocation id given up on. */
      from: string
      /** The next invocation id in the chain. */
      to: string
      /**
       * Why `from` was given up on: its retries or wait budget ran out
       * (`exhausted`), the classifier said `fallback`, or it was skipped
       * because an earlier call of this wrapper exhausted it (`sticky`).
       */
      reason: "exhausted" | "fallback" | "sticky"
      error?: unknown
    }

/**
 * What the wrapper did on a call that succeeded, reported as `meta.retry` on
 * the result. Consumers audit which model actually served a call from it.
 */
export interface RetryReport {
  /** The id of the invocation that answered. */
  served: string
  /** Its position in the chain: 0 is the primary, n the n-th fallback. */
  position: number
  /** Every call made for this invocation, including the one that answered. */
  attempts: number
  /** Ids of the models tried and given up on, in order; empty when the primary served. */
  fellBackFrom: string[]
  /** Total time this invocation spent waiting between attempts. */
  waitedMs: number
}

/** Exponential backoff: `baseMs × 2^(retry−1)`, capped at `maxMs`. */
export interface BackoffOptions {
  /** The first wait. Default 500. */
  baseMs?: number
  /** The longest single wait. Default 8000. */
  maxMs?: number
  /**
   * Randomise each wait between half and all of its computed value, so many
   * callers refused at once do not retry in step. Default true.
   */
  jitter?: boolean
}

export interface RetryOptions<Req, Res> {
  /**
   * Calls per model, including the first. Default 3 (the SDK default this
   * replaces: one call plus two retries). 1 means never retry, only fall back.
   */
  maxAttempts?: number
  /**
   * The wait before retry `n` (from 1): exponential options, or a function for
   * a fixed schedule (`(n) => [1000, 2000, 3000][n - 1] ?? 3000`).
   */
  backoff?: BackoffOptions | ((retry: number) => number)
  /**
   * Wait what the server's `Retry-After` (or `retry-after-ms`) header asks
   * instead of the computed backoff. Default true. A server wait longer than
   * the remaining budget is not shortened, since a shortened wait would only
   * be refused again: that model is given up on and the chain moves on.
   */
  respectRetryAfter?: boolean
  /**
   * The longest server-asked wait honoured. Default 60000, as the vendor SDKs
   * do. A `Retry-After` above it is treated as a wait that does not fit: that
   * model is given up on and the chain moves on, rather than sleeping for an
   * implausible hour or day.
   */
  maxRetryAfterMs?: number
  /** Decide each failure. Default {@link defaultRetryClassifier}. */
  classify?: (err: unknown) => RetryDecision
  /**
   * The ordered models to try once the primary is given up on. Empty (the
   * default) means retry only: the kernel never picks a fallback by itself.
   */
  fallbacks?: ModelInvocation<Req, Res>[]
  /**
   * The absolute deadline (epoch ms) every attempt must finish by, or a
   * function returning it. The wrapper never starts a wait that would run past
   * it. The call's context bounds it too: `InvokeContext.budget.deadlineAt`
   * (which the native loop sets to the run's deadline, so a wrapped model in
   * `runConversation` or `runAgent` knows how much of the run is left) and
   * `budget.maxDurationMs` counted from the call's start. The earliest wins.
   * Set this when the model is called outside the native loop, or when the
   * caller's own deadline is earlier than the run's.
   */
  deadlineAt?: number | (() => number)
  /**
   * Time to leave for the call itself: a wait that would leave less than this
   * before the deadline is not started. Default 0.
   */
  minCallMs?: number
  /**
   * The most this wrapper waits in total, summed across every call made
   * through it. Default unlimited.
   *
   * This budget belongs to the INSTANCE and never refills, so build one
   * wrapper per run or turn when you set it. A wrapper registered once at
   * startup and shared by every run would spend it on the first rate limit
   * and never retry again.
   */
  waitBudgetMs?: number
  /**
   * Once a model has been given up on because its retries or wait budget ran
   * out, start every later call of this wrapper at the next model rather than
   * asking it again (asking a rate-limited model again only adds a refusal
   * under the same limit). A `fallback` decision does not make it sticky.
   * Default false.
   *
   * Like `waitBudgetMs`, this is instance state that never resets: build one
   * wrapper per run or turn when you set it. A wrapper with neither option
   * keeps no state between calls and is safe to share.
   */
  stickyFallback?: boolean
  /**
   * The run is private (`RunSpec.private`): its material must stay on the one
   * model it was given. Retrying that model is allowed; a fallback chain is
   * refused when the wrapper is built, because a fallback is exactly a way for
   * the material to reach another model. `onEvent` then receives no `error`,
   * since an error can quote the material.
   *
   * Caller-declared today: the native engine selects its own provider and
   * takes no injected model, so a private run cannot reach this wrapper. A
   * hook that ever lets an engine wrap its model must pass `RunSpec.private`
   * through here, or this refusal becomes a hope.
   */
  private?: boolean
  /** Told about each retry and fallback as it happens. A throwing observer is logged and skipped. */
  onEvent?: (event: RetryEvent) => void
  /** Injectable for tests. Must reject with `signal.reason` when it aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injectable for tests. Default `Date.now`. */
  now?: () => number
  /** Injectable for tests (jitter). Default `Math.random`. */
  random?: () => number
}

/**
 * Thrown when every model in the chain failed without a fatal error: the last
 * failure is its `cause`, every failure is in `failures`. A `fatal` error is
 * never wrapped, and neither is an abort.
 */
export class RetryExhaustedError extends Error {
  /** Each failed call, in order. */
  readonly failures: { model: string; error: unknown }[]
  /** Why the chain stopped: every model was tried, or the deadline left no room for another attempt. */
  readonly reason: "exhausted" | "deadline"

  constructor(
    failures: { model: string; error: unknown }[],
    reason: "exhausted" | "deadline",
    cause: unknown,
  ) {
    const models = [...new Set(failures.map((f) => f.model))].join(", ")
    super(
      `model call failed after ${failures.length} attempt(s) across ${models || "no model"}` +
        (reason === "deadline" ? " (deadline reached)" : ""),
      { cause },
    )
    this.name = "RetryExhaustedError"
    this.failures = failures
    this.reason = reason
  }
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_MS = 500
const DEFAULT_MAX_MS = 8000
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000

/** Statuses worth asking again: timeout, conflict, too early, rate limit, and server-side faults. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429])
/** Server-side statuses no retry fixes: not implemented, version not supported. */
const PERMANENT_SERVER_STATUSES = new Set([501, 505])
/** Configuration faults no attempt can fix, by class name so a second copy of the package still matches. */
const FATAL_NAMES = new Set(["ProviderCredentialsError", "ProviderOptionsError", "CapabilityError"])
/** Connection-level failures the SDKs and the platform raise without a status. */
const TRANSIENT_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"])
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])

// The two helpers below are the default classifier's heuristics. They are
// exported for this module's tests only, not from the package: a public
// export would commit the API to a message-prefix guess.

/**
 * The HTTP status a failed call carries: the SDK error's `status` (or
 * `statusCode`), else a leading status in its message ("429 Rate limit
 * exceeded"), which is how some gateways' errors arrive.
 */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown } | null
  if (typeof e?.status === "number") return e.status
  if (typeof e?.statusCode === "number") return e.statusCode
  const message = err instanceof Error ? err.message : undefined
  const match = message ? /^\s*([1-5]\d\d)\b/.exec(message) : null
  return match?.[1] ? Number(match[1]) : undefined
}

/**
 * The wait a failed call's server asked for, in ms: `retry-after-ms`, else
 * `retry-after` as seconds or an HTTP date. Read from the error's `headers`,
 * a `Headers` or a plain record, the way the SDKs attach them.
 */
export function retryAfterMs(err: unknown, now: number = Date.now()): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers
  if (!headers || typeof headers !== "object") return undefined
  const read = (name: string): string | undefined => {
    const raw: unknown =
      typeof (headers as Headers).get === "function"
        ? (headers as Headers).get(name)
        : Object.entries(headers as Record<string, unknown>).find(
            ([key]) => key.toLowerCase() === name,
          )?.[1]
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined
  }
  const rawMs = read("retry-after-ms")
  if (rawMs !== undefined && Number.isFinite(Number(rawMs))) return Math.max(0, Number(rawMs))
  const raw = read("retry-after")
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * The default classification: rate limits, timeouts, server faults (but not
 * 501/505) and dropped connections are retried; a nested `withRetry` that ran
 * out moves this chain to its next model; everything else — auth (401/403), payment
 * (402), an invalid request (400/404/422), a credential or option the kernel
 * refused, and any error it cannot recognise — is fatal. Unknown errors are
 * fatal on purpose: retrying what nobody classified hides it.
 */
export function defaultRetryClassifier(err: unknown): RetryDecision {
  // A nested wrapper that ran out: its own policy already retried, so move on
  // to the next model rather than halting this chain or retrying it again.
  if (err instanceof RetryExhaustedError) return "fallback"
  if (err instanceof Error && FATAL_NAMES.has(err.name)) return "fatal"
  const status = errorStatus(err)
  if (status !== undefined) {
    if (PERMANENT_SERVER_STATUSES.has(status)) return "fatal"
    return RETRYABLE_STATUSES.has(status) || status >= 500 ? "retry" : "fatal"
  }
  if (err instanceof Error) {
    if (TRANSIENT_NAMES.has(err.name) || TRANSIENT_NAMES.has(err.constructor.name)) return "retry"
    const code = (err as { code?: unknown }).code
    const causeCode = (err.cause as { code?: unknown } | undefined)?.code
    if (TRANSIENT_CODES.has(String(code)) || TRANSIENT_CODES.has(String(causeCode))) return "retry"
  }
  return "fatal"
}

/**
 * Wrap a model in retry-and-fallback.
 *
 * The returned invocation keeps the primary's `id` and `kind`; its `caps` are
 * what every model in the chain can do (a capability one fallback lacks is not
 * advertised), and it streams only when all of them stream. `probe` asks the
 * primary.
 *
 * On success the result is the serving model's, with `meta.retry` set to a
 * {@link RetryReport}. A streaming call is never retried or sent to a fallback
 * once its sink has received anything: the caller has already shown that
 * output, and a second answer spliced after it would be a different reply.
 *
 * An abort (the call's `signal`) stops a wait at once and is rethrown as the
 * signal's reason, the same as an abort mid-request, so the loop still reads
 * it as a clean stop.
 */
export function withRetry<Req, Res>(
  primary: ModelInvocation<Req, Res>,
  options: RetryOptions<Req, Res> = {},
): ModelInvocation<Req, Res> {
  const fallbacks = options.fallbacks ?? []
  if (options.private && fallbacks.length > 0) {
    throw new Error(
      `a private run cannot fall back from ${primary.kind}:${primary.id} to another model; ` +
        "its material stays on the model it was given",
    )
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a whole number of at least 1 (got ${maxAttempts})`)
  }

  const chain = [primary, ...fallbacks]
  const classify = options.classify ?? defaultRetryClassifier
  const respectRetryAfter = options.respectRetryAfter ?? true
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
  const minCallMs = options.minCallMs ?? 0
  const sleep = options.sleep ?? abortableSleep
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const delayFor = backoffSchedule(options.backoff, random)

  // Instance state, the only state the wrapper keeps: the wait budget spent so
  // far and the first model a call should start at (both span calls, so one
  // instance per run spends one budget).
  let waitedTotal = 0
  let startAt = 0

  const caps: ModelCaps = {
    streaming: chain.every((m) => m.caps.streaming && m.invokeStream !== undefined),
    tools: chain.every((m) => m.caps.tools),
    multimodalInput: chain.every((m) => m.caps.multimodalInput),
    usage: chain.every((m) => m.caps.usage),
  }

  const notify = (ctx: InvokeContext, event: RetryEvent): void => {
    if (!options.onEvent) return
    if (options.private && "error" in event) {
      const { error: _withheld, ...rest } = event
      event = rest
    }
    try {
      options.onEvent(event)
    } catch (err) {
      ctx.log(`retry observer threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function run(
    ctx: InvokeContext,
    call: (model: ModelInvocation<Req, Res>) => Promise<ModelResult<Res>>,
    outputStarted: () => boolean,
  ): Promise<ModelResult<Res>> {
    const started = now()
    const deadline = Math.min(
      typeof options.deadlineAt === "function"
        ? options.deadlineAt()
        : (options.deadlineAt ?? Infinity),
      ctx.budget?.deadlineAt ?? Infinity,
      ctx.budget?.maxDurationMs !== undefined ? started + ctx.budget.maxDurationMs : Infinity,
    )
    const failures: { model: string; error: unknown }[] = []
    const fellBackFrom: string[] = []
    let waited = 0

    const giveUp = (position: number, reason: "exhausted" | "fallback", error: unknown): void => {
      const from = chain[position]!
      fellBackFrom.push(from.id)
      if (reason === "exhausted" && options.stickyFallback && position === startAt) {
        startAt = Math.min(position + 1, chain.length - 1)
      }
      const next = chain[position + 1]
      if (next) notify(ctx, { type: "fallback", from: from.id, to: next.id, reason, error })
    }

    // A sticky skip is reported once per call, so an observer still sees the
    // call land on a fallback.
    const first = Math.min(startAt, chain.length - 1)
    for (let p = 0; p < first; p++) {
      fellBackFrom.push(chain[p]!.id)
      notify(ctx, { type: "fallback", from: chain[p]!.id, to: chain[p + 1]!.id, reason: "sticky" })
    }

    for (let position = first; position < chain.length; position++) {
      const model = chain[position]!
      for (let attempt = 1; ; attempt++) {
        ctx.signal?.throwIfAborted()
        // The first call always goes out (the loop's own deadline stops a run
        // with no time left); only a retry or a fallback is held to the budget.
        if (failures.length > 0 && now() + minCallMs >= deadline) {
          throw new RetryExhaustedError(failures, "deadline", failures.at(-1)?.error)
        }
        try {
          const result = await call(model)
          const report: RetryReport = {
            served: model.id,
            position,
            attempts: failures.length + 1,
            fellBackFrom,
            waitedMs: waited,
          }
          return { ...result, meta: { ...result.meta, retry: report } }
        } catch (err) {
          // An abort is the caller stopping, not the model failing; output
          // already handed to a stream sink cannot be taken back. Neither is
          // retried, and neither is wrapped.
          if (ctx.signal?.aborted || outputStarted()) throw err
          const decision = classify(err)
          if (decision === "fatal") throw err
          failures.push({ model: model.id, error: err })
          const label = `${model.kind}:${model.id}`
          const message = err instanceof Error ? err.message : String(err)

          if (decision === "retry" && attempt < maxAttempts) {
            const asked = respectRetryAfter ? retryAfterMs(err, now()) : undefined
            const wait = asked ?? delayFor(attempt)
            const fits =
              (asked === undefined || asked <= maxRetryAfterMs) &&
              waitedTotal + wait <= (options.waitBudgetMs ?? Infinity) &&
              now() + wait + minCallMs < deadline
            if (fits) {
              ctx.log(
                `model ${label} attempt ${attempt} failed (${message}); retrying in ${wait}ms`,
              )
              notify(ctx, {
                type: "retry",
                model: model.id,
                attempt,
                delayMs: wait,
                retryAfter: asked !== undefined,
                error: err,
              })
              await sleep(wait, ctx.signal)
              waited += wait
              waitedTotal += wait
              continue
            }
            ctx.log(`model ${label} attempt ${attempt} failed (${message}); no time left to retry`)
          } else {
            ctx.log(`model ${label} attempt ${attempt} failed (${message}); giving up on it`)
          }
          giveUp(position, decision === "fallback" ? "fallback" : "exhausted", err)
          break
        }
      }
    }
    throw new RetryExhaustedError(failures, "exhausted", failures.at(-1)?.error)
  }

  return {
    id: primary.id,
    kind: primary.kind,
    caps,
    invoke: (req, ctx) =>
      run(
        ctx,
        (model) => model.invoke(req, ctx),
        () => false,
      ),
    ...(caps.streaming
      ? {
          invokeStream: (req: Req, sink: StreamSink, ctx: InvokeContext) => {
            let started = false
            const mark =
              <A extends unknown[]>(handler: ((...args: A) => void) | undefined) =>
              (...args: A) => {
                started = true
                handler?.(...args)
              }
            const tracked: StreamSink = {
              onTextDelta: mark(sink.onTextDelta),
              onToolCallStart: mark(sink.onToolCallStart),
              onToolCallDelta: mark(sink.onToolCallDelta),
              onToolCallComplete: mark(sink.onToolCallComplete),
            }
            return run(
              ctx,
              (model) => model.invokeStream!(req, tracked, ctx),
              () => started,
            )
          },
        }
      : {}),
    probe: (): Promise<Health> => primary.probe(),
  }
}

/** The wait before retry `n`, from the caller's schedule or exponential options. */
function backoffSchedule(
  backoff: RetryOptions<unknown, unknown>["backoff"],
  random: () => number,
): (retry: number) => number {
  if (typeof backoff === "function") return (retry) => Math.max(0, backoff(retry))
  const baseMs = backoff?.baseMs ?? DEFAULT_BASE_MS
  const maxMs = backoff?.maxMs ?? DEFAULT_MAX_MS
  const jitter = backoff?.jitter ?? true
  return (retry) => {
    const full = Math.min(maxMs, baseMs * 2 ** (retry - 1))
    return Math.round(jitter ? full / 2 + (random() * full) / 2 : full)
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
