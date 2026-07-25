import { randomUUID } from "node:crypto"
import {
  modelIdentity,
  type Health,
  type HealthStatus,
  type InvokeContext,
  type ModelIdentity,
  type ModelInvocation,
  type ModelResult,
  type StreamSink,
} from "./types.js"

/** A non-streaming invocation, with its payload types erased. */
export type Invoker = (req: unknown, ctx: InvokeContext) => Promise<ModelResult<unknown>>

/** A streaming invocation, with its payload types erased. */
export type StreamInvoker = (
  req: unknown,
  sink: StreamSink,
  ctx: InvokeContext,
) => Promise<ModelResult<unknown>>

/**
 * A cross-cutting concern wrapped around an invocation.
 *
 * Middleware is deliberately payload-blind: it sees `unknown` in and
 * `ModelResult<unknown>` out. That is the whole point — tracing, redaction,
 * health tracking and budget enforcement are identical whether the call is a
 * chat completion or an object-detection pass, so one implementation must cover
 * both. A middleware that needs to know the payload type has stopped being
 * cross-cutting and belongs in the kind's own implementation.
 *
 * Both hooks are optional: a middleware that only cares about buffered calls
 * implements `invoke` and leaves streaming untouched.
 */
export interface Middleware {
  readonly name: string
  invoke?: (next: Invoker, model: ModelIdentity) => Invoker
  invokeStream?: (next: StreamInvoker, model: ModelIdentity) => StreamInvoker
}

/**
 * Wrap an invocation in a middleware chain. The first entry is outermost, so
 * `withMiddleware(m, [trace, redact])` runs trace's before-logic first and its
 * after-logic last.
 *
 * The returned invocation keeps the original's `id`, `kind` and `caps`, and
 * only exposes `invokeStream` when the original did — wrapping must never
 * appear to add a capability the underlying model doesn't have.
 */
export function withMiddleware<Req, Res>(
  model: ModelInvocation<Req, Res>,
  middleware: Middleware[],
): ModelInvocation<Req, Res> {
  if (middleware.length === 0) return model
  const identity = modelIdentity(model)

  const baseInvoke: Invoker = (req, ctx) => model.invoke(req as Req, ctx)
  const invoke = middleware
    .filter((m) => m.invoke)
    .reduceRight<Invoker>((next, m) => m.invoke!(next, identity), baseInvoke)

  const streaming = model.invokeStream?.bind(model)
  const invokeStream = streaming
    ? middleware
        .filter((m) => m.invokeStream)
        .reduceRight<StreamInvoker>(
          (next, m) => m.invokeStream!(next, identity),
          (req, sink, ctx) => streaming(req as Req, sink, ctx),
        )
    : undefined

  return {
    id: model.id,
    kind: model.kind,
    caps: model.caps,
    invoke: async (req, ctx) => (await invoke(req, ctx)) as ModelResult<Res>,
    ...(invokeStream
      ? {
          invokeStream: async (req: Req, sink: StreamSink, ctx: InvokeContext) =>
            (await invokeStream(req, sink, ctx)) as ModelResult<Res>,
        }
      : {}),
    probe: () => model.probe(),
  }
}

// ── Built-in middleware ──────────────────────────────────────────────────────
// Generic mechanics only. Anything that encodes a *policy* (which model to fall
// back to, what a given product considers sensitive) belongs in an app layer
// that supplies its own middleware.

/**
 * Ensure every call carries a correlation id, minting one when the caller
 * didn't supply it, so a whole chain of invocations shares a single id. Pass
 * your own `mint` to adopt an ambient trace id from the surrounding request.
 */
export function correlationMiddleware(mint: () => string = () => randomUUID()): Middleware {
  const withId = (ctx: InvokeContext): InvokeContext =>
    ctx.correlationId ? ctx : { ...ctx, correlationId: mint() }

  return {
    name: "correlation",
    invoke: (next) => (req, ctx) => next(req, withId(ctx)),
    invokeStream: (next) => (req, sink, ctx) => next(req, sink, withId(ctx)),
  }
}

/** Log each invocation's start, outcome and duration through `ctx.log`. */
export function loggingMiddleware(): Middleware {
  const run = async <T>(
    model: ModelIdentity,
    ctx: InvokeContext,
    call: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now()
    const label = `${model.kind}:${model.id}`
    try {
      const result = await call()
      ctx.log(`model ${label} ok (${Date.now() - started}ms)`)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.log(`model ${label} error after ${Date.now() - started}ms: ${message}`)
      throw err
    }
  }

  return {
    name: "logging",
    invoke: (next, model) => (req, ctx) => run(model, ctx, () => next(req, ctx)),
    invokeStream: (next, model) => (req, sink, ctx) => run(model, ctx, () => next(req, sink, ctx)),
  }
}

/** Records per-model health derived from invocation outcomes. */
export class HealthTracker {
  private readonly statuses = new Map<string, Health>()

  record(model: ModelIdentity, status: HealthStatus, detail?: string): void {
    this.statuses.set(`${model.kind}:${model.id}`, { status, ...(detail ? { detail } : {}) })
  }

  get(model: ModelIdentity): Health {
    return (
      this.statuses.get(`${model.kind}:${model.id}`) ?? {
        status: "unknown",
        detail: "no invocation recorded yet",
      }
    )
  }

  /** Every model this tracker has observed, keyed `kind:id`. */
  snapshot(): Record<string, Health> {
    return Object.fromEntries(this.statuses)
  }
}

/**
 * Track reachability from real traffic rather than a separate probe: a
 * successful invocation marks the model up, a thrown one marks it down. This is
 * the generic form of the health bookkeeping a hand-rolled client does inline.
 */
export function healthTrackingMiddleware(tracker: HealthTracker): Middleware {
  const run = async <T>(model: ModelIdentity, call: () => Promise<T>): Promise<T> => {
    try {
      const result = await call()
      tracker.record(model, "up")
      return result
    } catch (err) {
      tracker.record(model, "down", err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  return {
    name: "health-tracking",
    invoke: (next, model) => (req, ctx) => run(model, () => next(req, ctx)),
    invokeStream: (next, model) => (req, sink, ctx) => run(model, () => next(req, sink, ctx)),
  }
}

/**
 * Map thrown errors through a caller-supplied redactor before they propagate,
 * so a failure carrying a prompt, an image payload or an auth header can be
 * scrubbed once instead of at every catch site. The kernel supplies the seam,
 * never the notion of what is sensitive — that is the application's call.
 */
export function errorRedactionMiddleware(redact: (err: unknown) => unknown): Middleware {
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (err) {
      throw redact(err)
    }
  }

  return {
    name: "error-redaction",
    invoke: (next) => (req, ctx) => run(() => next(req, ctx)),
    invokeStream: (next) => (req, sink, ctx) => run(() => next(req, sink, ctx)),
  }
}
