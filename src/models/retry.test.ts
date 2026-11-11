import { describe, it, expect } from "vitest"
import { runConversation } from "../agent.js"
import { ProviderCredentialsError } from "../providers/index.js"
import { ScriptedProvider } from "../providers/scripted.js"
import { chatModel } from "./chat.js"
import {
  defaultRetryClassifier,
  errorStatus,
  retryAfterMs,
  RetryExhaustedError,
  withRetry,
  type RetryEvent,
  type RetryOptions,
  type RetryReport,
} from "./retry.js"
import {
  invokeStreaming,
  type InvokeContext,
  type ModelCaps,
  type ModelInvocation,
  type StreamSink,
} from "./types.js"

// ── Fakes ────────────────────────────────────────────────────────────────────

/** An error shaped like an SDK's APIError: a status and optional headers. */
function apiError(status: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(`${status} upstream said no`), { status, headers })
}

type Step = string | Error

const CAPS: ModelCaps = { streaming: false, tools: false, multimodalInput: false, usage: false }

/** A model that answers each call from `steps`, throwing the errors. */
function scripted(id: string, steps: Step[], caps: Partial<ModelCaps> = {}) {
  const calls: number[] = []
  let i = 0
  const next = (): string => {
    const step = steps[i++]
    if (step === undefined) throw new Error(`${id}: script exhausted`)
    if (step instanceof Error) throw step
    return step
  }
  const model: ModelInvocation<string, string> & { calls: number[] } = {
    id,
    kind: "test.echo",
    caps: { ...CAPS, ...caps },
    calls,
    invoke: (req) => {
      calls.push(clock.t)
      return Promise.resolve({ value: `${next()}:${req}`, meta: { from: id } })
    },
    probe: () => Promise.resolve({ status: "up", detail: id }),
  }
  return model
}

/** A virtual clock: `sleep` advances it instantly and honours the signal. */
const clock = { t: 1_000_000 }
const sleeps: number[] = []
function fakeTime(): Pick<RetryOptions<string, string>, "now" | "sleep" | "random"> {
  clock.t = 1_000_000
  sleeps.length = 0
  return {
    now: () => clock.t,
    random: () => 1,
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(signal.reason as Error)
      sleeps.push(ms)
      clock.t += ms
      return Promise.resolve()
    },
  }
}

const lines: string[] = []
const ctx = (extra: Partial<InvokeContext> = {}): InvokeContext => ({
  log: (line) => lines.push(line),
  ...extra,
})

const report = (meta: Record<string, unknown> | undefined): RetryReport =>
  meta?.retry as RetryReport

// ── Retry ────────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("passes a first-try success straight through and reports it", async () => {
    const primary = scripted("a", ["ok"])
    const model = withRetry(primary, fakeTime())
    const result = await model.invoke("hi", ctx())
    expect(result.value).toBe("ok:hi")
    expect(result.meta?.from).toBe("a")
    expect(report(result.meta)).toEqual({
      served: "a",
      position: 0,
      attempts: 1,
      fellBackFrom: [],
      waitedMs: 0,
    })
    expect(sleeps).toEqual([])
  })

  it("keeps the primary's identity and asks it for health", async () => {
    const model = withRetry(scripted("a", []), fakeTime())
    expect(model.id).toBe("a")
    expect(model.kind).toBe("test.echo")
    expect(await model.probe()).toEqual({ status: "up", detail: "a" })
  })

  it("retries a transient failure with exponential backoff, then succeeds", async () => {
    const primary = scripted("a", [apiError(503), apiError(429), "ok"])
    const model = withRetry(primary, { ...fakeTime(), backoff: { baseMs: 100, jitter: false } })
    const result = await model.invoke("hi", ctx())
    expect(result.value).toBe("ok:hi")
    expect(sleeps).toEqual([100, 200])
    expect(report(result.meta)).toMatchObject({ served: "a", attempts: 3, waitedMs: 300 })
  })

  it("jitters each wait between half and all of its value", async () => {
    const primary = scripted("a", [apiError(500), "ok"])
    const model = withRetry(primary, {
      ...fakeTime(),
      random: () => 0,
      backoff: { baseMs: 1000 },
    })
    await model.invoke("hi", ctx())
    expect(sleeps).toEqual([500])
  })

  it("honours Retry-After in seconds and retry-after-ms over the computed backoff", async () => {
    const primary = scripted("a", [
      apiError(429, { "retry-after": "3" }),
      apiError(429, { "retry-after-ms": "250" }),
      "ok",
    ])
    const model = withRetry(primary, { ...fakeTime(), backoff: () => 10 })
    await model.invoke("hi", ctx())
    expect(sleeps).toEqual([3000, 250])
  })

  it("ignores Retry-After when told to", async () => {
    const primary = scripted("a", [apiError(429, { "retry-after": "30" }), "ok"])
    const model = withRetry(primary, {
      ...fakeTime(),
      backoff: () => 10,
      respectRetryAfter: false,
    })
    await model.invoke("hi", ctx())
    expect(sleeps).toEqual([10])
  })

  it("rethrows a non-retryable error unchanged, without a second call", async () => {
    const denied = apiError(401)
    const primary = scripted("a", [denied, "ok"])
    const fallback = scripted("b", ["ok"])
    const model = withRetry(primary, { ...fakeTime(), fallbacks: [fallback] })
    await expect(model.invoke("hi", ctx())).rejects.toBe(denied)
    expect(primary.calls).toHaveLength(1)
    expect(fallback.calls).toHaveLength(0)
  })

  it("treats a refused credential as fatal", async () => {
    const err = new ProviderCredentialsError("anthropic", ["ANTHROPIC_API_KEY"], "no key")
    const primary = scripted("a", [err])
    await expect(withRetry(primary, fakeTime()).invoke("hi", ctx())).rejects.toBe(err)
  })

  it("throws RetryExhaustedError with every failure once attempts run out", async () => {
    const errors = [apiError(500), apiError(502), apiError(503)]
    const primary = scripted("a", errors)
    const model = withRetry(primary, { ...fakeTime(), backoff: () => 1 })
    const err = await model.invoke("hi", ctx()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetryExhaustedError)
    const exhausted = err as RetryExhaustedError
    expect(exhausted.reason).toBe("exhausted")
    expect(exhausted.cause).toBe(errors[2])
    expect(exhausted.failures.map((f) => f.error)).toEqual(errors)
    expect(primary.calls).toHaveLength(3)
  })

  it("refuses a maxAttempts below one", () => {
    expect(() => withRetry(scripted("a", []), { maxAttempts: 0 })).toThrow(/at least 1/)
  })

  // ── Deadline and abort ─────────────────────────────────────────────────────

  it("does not start a wait that would cross the deadline", async () => {
    const time = fakeTime()
    const primary = scripted("a", [apiError(429, { "retry-after": "5" }), "ok"])
    const model = withRetry(primary, { ...time, deadlineAt: clock.t + 4000 })
    const err = await model.invoke("hi", ctx()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetryExhaustedError)
    expect(sleeps).toEqual([])
    expect(primary.calls).toHaveLength(1)
  })

  it("leaves minCallMs for the call after a wait", async () => {
    const time = fakeTime()
    const primary = scripted("a", [apiError(500), "ok"])
    const model = withRetry(primary, {
      ...time,
      backoff: () => 1000,
      deadlineAt: () => clock.t + 5000,
      minCallMs: 4500,
    })
    await expect(model.invoke("hi", ctx())).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(sleeps).toEqual([])
  })

  it("is bounded by the call's own budget.maxDurationMs too", async () => {
    const primary = scripted("a", [apiError(500), "ok"])
    const model = withRetry(primary, { ...fakeTime(), backoff: () => 2000 })
    await expect(
      model.invoke("hi", ctx({ budget: { maxDurationMs: 1500 } })),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(sleeps).toEqual([])
  })

  it("stops a wait when the signal aborts, rethrowing the signal's reason", async () => {
    const controller = new AbortController()
    const primary = scripted("a", [apiError(503), "ok"])
    const model = withRetry(primary, {
      // The real sleep: the abort below must cut it short.
      backoff: () => 60_000,
    })
    const pending = model.invoke("hi", ctx({ signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const reason = new Error("caller canceled")
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(primary.calls).toHaveLength(1)
  })

  it("never retries an error raised after the signal fired", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    const primary = scripted("a", [apiError(503), "ok"])
    const model = withRetry(primary, fakeTime())
    await expect(model.invoke("hi", ctx({ signal: controller.signal }))).rejects.toThrow("stop")
    expect(primary.calls).toHaveLength(0)
  })

  it("spends waitBudgetMs once across calls of the same wrapper", async () => {
    const primary = scripted("a", [apiError(429), "one", apiError(429), "two"])
    const fallback = scripted("b", ["fb"])
    const model = withRetry(primary, {
      ...fakeTime(),
      backoff: () => 1000,
      waitBudgetMs: 1500,
      fallbacks: [fallback],
    })
    expect((await model.invoke("x", ctx())).value).toBe("one:x")
    // The second call's wait would take the total to 2000 > 1500: fall back.
    const second = await model.invoke("y", ctx())
    expect(second.value).toBe("fb:y")
    expect(report(second.meta)).toMatchObject({ served: "b", position: 1, fellBackFrom: ["a"] })
    expect(sleeps).toEqual([1000])
  })

  // ── Fallback ───────────────────────────────────────────────────────────────

  it("walks the fallback chain in order and reports who served", async () => {
    const events: RetryEvent[] = []
    const a = scripted("a", [apiError(500), apiError(500)])
    const b = scripted("b", [apiError(429), apiError(429)])
    const c = scripted("c", ["ok"])
    const model = withRetry(a, {
      ...fakeTime(),
      maxAttempts: 2,
      backoff: () => 5,
      fallbacks: [b, c],
      onEvent: (e) => events.push(e),
    })
    const result = await model.invoke("hi", ctx())
    expect(result.value).toBe("ok:hi")
    expect(result.meta?.from).toBe("c")
    expect(report(result.meta)).toEqual({
      served: "c",
      position: 2,
      attempts: 5,
      fellBackFrom: ["a", "b"],
      waitedMs: 10,
    })
    expect(
      events.map((e) => (e.type === "retry" ? `retry ${e.model}` : `${e.from}>${e.to}`)),
    ).toEqual(["retry a", "a>b", "retry b", "b>c"])
  })

  it("moves on at once on a `fallback` decision", async () => {
    const a = scripted("a", [apiError(500)])
    const b = scripted("b", ["ok"])
    const model = withRetry(a, {
      ...fakeTime(),
      fallbacks: [b],
      classify: (err) => (errorStatus(err) === 429 ? "retry" : "fallback"),
    })
    expect((await model.invoke("hi", ctx())).value).toBe("ok:hi")
    expect(a.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it("throws RetryExhaustedError when the whole chain fails", async () => {
    const a = scripted("a", [apiError(500)])
    const b = scripted("b", [apiError(502)])
    const model = withRetry(a, { ...fakeTime(), maxAttempts: 1, fallbacks: [b] })
    const err = (await model.invoke("hi", ctx()).catch((e: unknown) => e)) as RetryExhaustedError
    expect(err).toBeInstanceOf(RetryExhaustedError)
    expect(err.failures.map((f) => f.model)).toEqual(["a", "b"])
    expect(err.message).toContain("a, b")
  })

  it("has no fallback unless one is configured", async () => {
    const a = scripted("a", [apiError(500)])
    const model = withRetry(a, { ...fakeTime(), maxAttempts: 1 })
    await expect(model.invoke("hi", ctx())).rejects.toBeInstanceOf(RetryExhaustedError)
  })

  it("with stickyFallback, skips an exhausted primary on later calls", async () => {
    const events: RetryEvent[] = []
    const a = scripted("a", [apiError(429), apiError(429)])
    const b = scripted("b", ["one", "two"])
    const model = withRetry(a, {
      ...fakeTime(),
      maxAttempts: 2,
      backoff: () => 1,
      stickyFallback: true,
      fallbacks: [b],
      onEvent: (e) => events.push(e),
    })
    await model.invoke("x", ctx())
    const second = await model.invoke("y", ctx())
    expect(second.value).toBe("two:y")
    expect(a.calls).toHaveLength(2)
    expect(report(second.meta)).toMatchObject({ served: "b", attempts: 1, fellBackFrom: ["a"] })
    expect(events.at(-1)).toEqual({ type: "fallback", from: "a", to: "b", reason: "sticky" })
  })

  it("logs and skips a throwing observer", async () => {
    lines.length = 0
    const a = scripted("a", [apiError(500), "ok"])
    const model = withRetry(a, {
      ...fakeTime(),
      onEvent: () => {
        throw new Error("observer broke")
      },
    })
    expect((await model.invoke("hi", ctx())).value).toBe("ok:hi")
    expect(lines.some((l) => l.includes("observer broke"))).toBe(true)
  })

  it("advertises only what every model in the chain can do", () => {
    const a = scripted("a", [], { tools: true, usage: true })
    const b = scripted("b", [], { tools: true, usage: false })
    const model = withRetry(a, { fallbacks: [b] })
    expect(model.caps).toEqual({
      streaming: false,
      tools: true,
      multimodalInput: false,
      usage: false,
    })
    expect("invokeStream" in model).toBe(false)
  })

  // ── Private runs ───────────────────────────────────────────────────────────

  it("refuses a fallback chain for a private run", () => {
    expect(() =>
      withRetry(scripted("local", []), { private: true, fallbacks: [scripted("cloud", [])] }),
    ).toThrow(/private run cannot fall back/)
  })

  it("still retries the one model of a private run", async () => {
    const local = scripted("local", [apiError(503), "ok"])
    const model = withRetry(local, { ...fakeTime(), private: true })
    expect((await model.invoke("hi", ctx())).value).toBe("ok:hi")
  })

  // ── Streaming ──────────────────────────────────────────────────────────────

  function streamer(id: string, behaviour: (sink: StreamSink) => string) {
    let calls = 0
    const model: ModelInvocation<string, string> & { calls: () => number } = {
      id,
      kind: "test.echo",
      caps: { ...CAPS, streaming: true },
      calls: () => calls,
      invoke: () => Promise.reject(new Error("buffered path not used")),
      invokeStream: async (_req, sink) => {
        calls++
        await Promise.resolve()
        return { value: behaviour(sink) }
      },
      probe: () => Promise.resolve({ status: "unknown" }),
    }
    return model
  }

  it("retries a stream that failed before any output", async () => {
    let first = true
    const a = streamer("a", (sink) => {
      if (first) {
        first = false
        throw apiError(503)
      }
      sink.onTextDelta?.("hel")
      sink.onTextDelta?.("lo")
      return "hello"
    })
    const deltas: string[] = []
    const model = withRetry(a, fakeTime())
    const result = await invokeStreaming(model, "hi", { onTextDelta: (d) => deltas.push(d) }, ctx())
    expect(result.value).toBe("hello")
    expect(deltas).toEqual(["hel", "lo"])
    expect(a.calls()).toBe(2)
  })

  it("never retries or falls back once a stream has produced output", async () => {
    const broke = apiError(503)
    const a = streamer("a", (sink) => {
      sink.onTextDelta?.("partial")
      throw broke
    })
    const b = streamer("b", () => "other")
    const model = withRetry(a, { ...fakeTime(), fallbacks: [b] })
    await expect(invokeStreaming(model, "hi", {}, ctx())).rejects.toBe(broke)
    expect(a.calls()).toBe(1)
    expect(b.calls()).toBe(0)
  })

  // ── Through the loop ───────────────────────────────────────────────────────

  it("serves a conversation from the fallback when the primary is down", async () => {
    const down = {
      name: "primary",
      model: "big-model",
      converse: () => Promise.reject(apiError(503)),
    }
    const backup = new ScriptedProvider([{ text: "answered", toolCalls: [] }], {
      model: "small-model",
    })
    const model = withRetry(chatModel(down), {
      ...(fakeTime() as RetryOptions<never, never>),
      maxAttempts: 1,
      fallbacks: [chatModel(backup)],
    })
    const result = await runConversation({
      provider: model,
      system: "",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      log: () => {},
    })
    expect(result.text).toBe("answered")
    expect(result.model).toBe("small-model")
  })
})

// ── Classification helpers ───────────────────────────────────────────────────

describe("defaultRetryClassifier", () => {
  it.each([
    [apiError(429), "retry"],
    [apiError(408), "retry"],
    [apiError(500), "retry"],
    [apiError(529), "retry"],
    [apiError(400), "fatal"],
    [apiError(401), "fatal"],
    [apiError(402), "fatal"],
    [apiError(403), "fatal"],
    [apiError(404), "fatal"],
    [apiError(422), "fatal"],
    [new Error("503 Service Unavailable"), "retry"],
    [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "retry"],
    [Object.assign(new Error("Connection error."), { name: "APIConnectionError" }), "retry"],
    [new Error("something nobody classified"), "fatal"],
    ["not even an error", "fatal"],
  ])("%s → %s", (err, expected) => {
    expect(defaultRetryClassifier(err)).toBe(expected)
  })
})

describe("retryAfterMs", () => {
  it("reads seconds, milliseconds and HTTP dates from a Headers or a record", () => {
    const now = Date.parse("2026-01-01T00:00:00Z")
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "2" }) }, now)).toBe(2000)
    expect(retryAfterMs({ headers: { "retry-after-ms": "120" } }, now)).toBe(120)
    expect(retryAfterMs({ headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" } }, now)).toBe(
      5000,
    )
    expect(retryAfterMs({ headers: { "retry-after": "soon" } }, now)).toBeUndefined()
    expect(retryAfterMs(new Error("no headers"), now)).toBeUndefined()
  })
})
