import { describe, it, expect } from "vitest"
import { runConversation } from "../agent.js"
import { ProviderCredentialsError } from "../providers/index.js"
import { ScriptedProvider } from "../providers/scripted.js"
import type { Tool } from "../tools/registry.js"
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
function apiError(status: number, headers?: Record<string, string>, message?: string): Error {
  return Object.assign(new Error(message ?? `${status} upstream said no`), { status, headers })
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

  it("names the fallback that served as the run's provider, the primary when it served", async () => {
    let primaryUp = false
    const primary = {
      name: "primary",
      converse: () =>
        primaryUp
          ? Promise.resolve({ text: "from primary", toolCalls: [] })
          : Promise.reject(apiError(503)),
    }
    const backup = new ScriptedProvider([{ text: "from backup", toolCalls: [] }], {
      name: "backup",
    })
    const model = withRetry(chatModel(primary), {
      ...(fakeTime() as RetryOptions<never, never>),
      maxAttempts: 1,
      fallbacks: [chatModel(backup)],
    })
    const run = () =>
      runConversation({
        provider: model,
        system: "",
        messages: [{ role: "user", text: "hi" }],
        tools: [],
        log: () => {},
      })

    const fellBack = await run()
    expect(fellBack.text).toBe("from backup")
    expect(fellBack.provider).toBe("backup")

    primaryUp = true
    const direct = await run()
    expect(direct.text).toBe("from primary")
    expect(direct.provider).toBe("primary")
  })

  it("reports the provider of the last call when the steps were served by different models", async () => {
    let call = 0
    const primary = {
      name: "primary",
      converse: () => {
        call++
        // The first step is served by the primary; the second falls back.
        return call === 1
          ? Promise.resolve({ text: "", toolCalls: [{ id: "t", name: "echo", input: {} }] })
          : Promise.reject(apiError(503))
      },
    }
    const backup = new ScriptedProvider([{ text: "done", toolCalls: [] }], { name: "backup" })
    const echo: Tool = {
      spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: () => Promise.resolve("ok"),
    }
    const result = await runConversation({
      provider: withRetry(chatModel(primary), {
        ...(fakeTime() as RetryOptions<never, never>),
        maxAttempts: 1,
        fallbacks: [chatModel(backup)],
      }),
      system: "",
      messages: [{ role: "user", text: "hi" }],
      tools: [echo],
      log: () => {},
    })
    expect(result.text).toBe("done")
    expect(result.provider).toBe("backup")
  })
})

// ── Review regressions ───────────────────────────────────────────────────────

describe("withRetry: review regressions", () => {
  it("a nested wrapper that runs out moves the outer chain on", async () => {
    const inner = withRetry(scripted("a", [apiError(503), apiError(503)]), {
      ...fakeTime(),
      maxAttempts: 2,
      backoff: () => 1,
    })
    const b = scripted("b", ["fb"])
    const outer = withRetry(inner, { ...fakeTime(), maxAttempts: 1, fallbacks: [b] })
    const result = await outer.invoke("x", ctx())
    expect(result.value).toBe("fb:x")
    expect(report(result.meta)).toMatchObject({ served: "b", position: 1, fellBackFrom: ["a"] })
  })

  it("does not sleep on a Retry-After above maxRetryAfterMs; the chain moves on", async () => {
    const a = scripted("a", [apiError(429, { "retry-after": "86400" }), "ok"])
    const b = scripted("b", ["fb"])
    const model = withRetry(a, { ...fakeTime(), fallbacks: [b] })
    expect((await model.invoke("x", ctx())).value).toBe("fb:x")
    expect(sleeps).toEqual([])
  })

  it("fails rather than sleeping a day when there is no fallback", async () => {
    const a = scripted("a", [apiError(429, { "retry-after": "86400" }), "ok"])
    await expect(withRetry(a, fakeTime()).invoke("x", ctx())).rejects.toBeInstanceOf(
      RetryExhaustedError,
    )
    expect(sleeps).toEqual([])
  })

  it("honours a longer server wait when maxRetryAfterMs allows it", async () => {
    const a = scripted("a", [apiError(429, { "retry-after": "90" }), "ok"])
    const model = withRetry(a, { ...fakeTime(), maxRetryAfterMs: 120_000 })
    await model.invoke("x", ctx())
    expect(sleeps).toEqual([90_000])
  })

  it("reads a Retry-After header whatever its case", async () => {
    const a = scripted("a", [apiError(429, { "Retry-After": "2" }), "ok"])
    await withRetry(a, { ...fakeTime(), backoff: () => 10 }).invoke("x", ctx())
    expect(sleeps).toEqual([2000])
  })

  it("spends waitBudgetMs per instance: a fresh wrapper per run retries again", async () => {
    const steps = [apiError(429), "one", apiError(429), "two"]
    const a = scripted("a", steps)
    const options = { ...fakeTime(), backoff: () => 1000, waitBudgetMs: 1500 }
    // One run, one wrapper: its budget is spent on the first rate limit.
    const run1 = withRetry(a, options)
    expect((await run1.invoke("x", ctx())).value).toBe("one:x")
    // The next run builds its own wrapper and gets a whole budget again.
    const run2 = withRetry(a, options)
    expect((await run2.invoke("y", ctx())).value).toBe("two:y")
    expect(sleeps).toEqual([1000, 1000])
  })

  it("keeps no state between calls without waitBudgetMs or stickyFallback", async () => {
    const a = scripted("a", [apiError(429), "one", apiError(429), "two", apiError(429), "three"])
    const shared = withRetry(a, { ...fakeTime(), backoff: () => 1000 })
    for (const expected of ["one", "two", "three"]) {
      expect((await shared.invoke("x", ctx())).value).toBe(`${expected}:x`)
    }
    expect(sleeps).toEqual([1000, 1000, 1000])
  })

  it("is bounded by the run deadline the context carries", async () => {
    const time = fakeTime()
    const a = scripted("a", [apiError(429, { "retry-after-ms": "200" }), "ok"])
    const b = scripted("b", ["fb"])
    const model = withRetry(a, { ...time, fallbacks: [b] })
    // A late step: the run's budget is 400 ms, but only 150 ms of it is left.
    const late = ctx({ budget: { maxDurationMs: 400, deadlineAt: clock.t + 150 } })
    expect((await model.invoke("x", late)).value).toBe("fb:x")
    expect(sleeps).toEqual([])
  })

  it("inside the loop, falls back when a late step's wait would cross the run deadline", async () => {
    // Step 1 takes ~500 ms of a 1000 ms run and calls a tool. Step 2 is refused
    // with a 700 ms Retry-After that no longer fits, so the backup answers
    // instead of the run timing out in the middle of the wait.
    let call = 0
    const primary = {
      name: "primary",
      converse: async () => {
        call++
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          return { text: "", toolCalls: [{ id: "t", name: "echo", input: {} }] }
        }
        throw apiError(429, { "retry-after-ms": "700" })
      },
    }
    const backup = new ScriptedProvider([{ text: "from backup", toolCalls: [] }])
    const echo: Tool = {
      spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: () => Promise.resolve("ok"),
    }
    const result = await runConversation({
      provider: withRetry(chatModel(primary), { fallbacks: [chatModel(backup)] }),
      system: "",
      messages: [{ role: "user", text: "hi" }],
      tools: [echo],
      maxDurationMs: 1000,
    })
    expect(result.outcome).toBe("completed")
    expect(result.text).toBe("from backup")
  })

  it("withholds errors from onEvent for a private run", async () => {
    const events: RetryEvent[] = []
    const local = scripted("local", [apiError(503), "ok"])
    const model = withRetry(local, { ...fakeTime(), private: true, onEvent: (e) => events.push(e) })
    await model.invoke("x", ctx())
    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty("error")
    expect(events[0]).toMatchObject({ type: "retry", model: "local", attempt: 1 })
  })

  it("keeps concurrent calls on one wrapper within its shared wait budget", async () => {
    const a = scripted("a", [apiError(503), apiError(503), "ok"])
    const model = withRetry(a, { ...fakeTime(), backoff: () => 10, waitBudgetMs: 10 })
    const [first, second] = await Promise.allSettled([
      model.invoke("x", ctx()),
      model.invoke("y", ctx()),
    ])
    // The first call reserved the whole budget before it slept, so the second
    // could not also wait: one 10 ms wait in total, not two.
    expect(sleeps).toEqual([10])
    expect(first).toMatchObject({ status: "fulfilled", value: { value: "ok:x" } })
    expect(second.status).toBe("rejected")
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(RetryExhaustedError)
  })

  it("gives back the wait budget a call reserved when its wait is cut short", async () => {
    const a = scripted("a", [apiError(503), apiError(503), "ok"])
    const model = withRetry(a, {
      ...fakeTime(),
      backoff: () => 10,
      waitBudgetMs: 10,
      // A call with a signal waits until it is aborted; one without returns at once.
      sleep: (ms, signal) =>
        signal
          ? new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason as Error)),
            )
          : (sleeps.push(ms), Promise.resolve()),
    })
    const controller = new AbortController()
    const stopped = model.invoke("x", ctx({ signal: controller.signal }))
    controller.abort(new Error("stopped"))
    await expect(stopped).rejects.toThrow("stopped")
    // Nothing was spent, so the next call still has the whole budget.
    expect((await model.invoke("y", ctx())).value).toBe("ok:y")
    expect(sleeps).toEqual([10])
  })

  it("refuses a private wrapper whose primary is a wrapper with fallbacks", () => {
    const rerouting = withRetry(scripted("local", ["ok"]), { fallbacks: [scripted("remote", [])] })
    expect(() => withRetry(rerouting, { private: true })).toThrow(/private run cannot fall back/)
    // Deeper nesting is seen through too.
    expect(() => withRetry(withRetry(rerouting), { private: true })).toThrow(
      /private run cannot fall back/,
    )
    // A nested private wrapper that only retries its one model is still fine.
    expect(() =>
      withRetry(withRetry(scripted("local", ["ok"]), { maxAttempts: 2, private: true }), {
        private: true,
      }),
    ).not.toThrow()
  })

  it("hands a nested wrapper the outer deadline, so it does not wait past it", async () => {
    const time = fakeTime()
    const inner = withRetry(scripted("a", [apiError(503), "ok"]), {
      ...time,
      backoff: () => 500,
    })
    const outer = withRetry(inner, { ...time, deadlineAt: clock.t + 100 })
    // The inner wrapper's 500 ms wait would overrun the outer 100 ms deadline,
    // so it gives up at once instead of sleeping.
    await expect(outer.invoke("x", ctx())).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(sleeps).toEqual([])
  })

  it("passes the effective deadline to the model it calls", async () => {
    const seen: (number | undefined)[] = []
    const probe: ModelInvocation<string, string> = {
      ...scripted("a", []),
      invoke: (_req, c) => {
        seen.push(c.budget?.deadlineAt)
        return Promise.resolve({ value: "ok" })
      },
    }
    const time = fakeTime()
    await withRetry(probe, { ...time, deadlineAt: clock.t + 100 }).invoke("x", ctx())
    await withRetry(probe, time).invoke("x", ctx())
    expect(seen).toEqual([1_000_100, undefined])
  })

  it("accounts a nested wrapper that ran out call by call", async () => {
    const time = fakeTime()
    const inner = withRetry(scripted("a", [apiError(503), apiError(503), apiError(503)]), {
      ...time,
      backoff: () => 5,
      fallbacks: [scripted("c", [apiError(503), apiError(503), apiError(503)])],
      maxAttempts: 3,
    })
    const outer = withRetry(inner, { ...time, maxAttempts: 1, fallbacks: [scripted("b", ["fb"])] })
    const result = await outer.invoke("x", ctx())
    expect(result.value).toBe("fb:x")
    // a and c each failed three times with two 5 ms waits, then b answered.
    expect(report(result.meta)).toEqual({
      served: "b",
      position: 1,
      attempts: 7,
      fellBackFrom: ["a", "c"],
      waitedMs: 20,
    })
  })

  it("carries every call and wait of a nested wrapper on the outer RetryExhaustedError", async () => {
    const time = fakeTime()
    const inner = withRetry(scripted("a", [apiError(503), apiError(503)]), {
      ...time,
      backoff: () => 5,
      maxAttempts: 2,
    })
    const outer = withRetry(inner, { ...time, maxAttempts: 1 })
    const err = await outer.invoke("x", ctx()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetryExhaustedError)
    expect((err as RetryExhaustedError).failures.map((f) => f.model)).toEqual(["a", "a"])
    expect((err as RetryExhaustedError).waitedMs).toBe(5)
  })

  it("keeps upstream error text out of a private wrapper's log lines", async () => {
    const leak = () => apiError(503, undefined, "503 upstream echoed: SECRET-FRAGMENT")
    const log: string[] = []
    const model = withRetry(scripted("local", [leak(), leak(), "ok"]), {
      ...fakeTime(),
      private: true,
      backoff: () => 1,
    })
    await model.invoke("x", { log: (l) => log.push(l) })
    expect(log.length).toBeGreaterThan(0)
    expect(log.join("\n")).not.toContain("SECRET-FRAGMENT")
    expect(log[0]).toContain("status 503")
  })

  it("narrows the failures and cause a private wrapper reports when it runs out", async () => {
    const leak = () => apiError(503, undefined, "503 upstream echoed: SECRET-FRAGMENT")
    const log: string[] = []
    const model = withRetry(scripted("local", [leak(), leak()]), {
      ...fakeTime(),
      private: true,
      maxAttempts: 2,
      backoff: () => 1,
    })
    const err = (await model
      .invoke("x", { log: (l) => log.push(l) })
      .catch((e: unknown) => e)) as RetryExhaustedError
    expect(err).toBeInstanceOf(RetryExhaustedError)
    const text = JSON.stringify([
      err.message,
      err.failures.map((f) => String(f.error)),
      String(err.cause),
      log,
    ])
    expect(text).not.toContain("SECRET-FRAGMENT")
    expect(err.failures).toHaveLength(2)
    expect(errorStatus(err.cause)).toBe(503)
  })

  it("refuses a private wrapper around a nested wrapper that is not private", () => {
    // The inner wrapper would log and report the material's error text itself.
    const inner = withRetry(scripted("local", ["ok"]), { maxAttempts: 2 })
    expect(() => withRetry(inner, { private: true })).toThrow(
      /must wrap only wrappers that are private/,
    )
  })

  it("keeps a private nested wrapper's failures narrowed through the outer one", async () => {
    const leak = () => apiError(503, undefined, "503 upstream echoed: SECRET-FRAGMENT")
    const log: string[] = []
    const inner = withRetry(scripted("local", [leak(), leak()]), {
      ...fakeTime(),
      private: true,
      maxAttempts: 2,
      backoff: () => 1,
    })
    const outer = withRetry(inner, { ...fakeTime(), private: true, maxAttempts: 1 })
    const err = (await outer
      .invoke("x", { log: (l) => log.push(l) })
      .catch((e: unknown) => e)) as RetryExhaustedError
    expect(err.failures).toHaveLength(2)
    expect(
      JSON.stringify([err.failures.map((f) => String(f.error)), String(err.cause), log]),
    ).not.toContain("SECRET-FRAGMENT")
  })

  it("still rethrows a fatal error unchanged under private: true", async () => {
    const fatal = apiError(400, undefined, "400 bad request: SECRET-FRAGMENT")
    const model = withRetry(scripted("local", [fatal]), { ...fakeTime(), private: true })
    // The model's own error, as an unwrapped call would throw it; the caller
    // keeps it off its channels (the native engine's private redaction does).
    await expect(model.invoke("x", ctx())).rejects.toBe(fatal)
  })

  it("reports the model inside a nested wrapper that actually answered", async () => {
    const inner = withRetry(scripted("a", [apiError(503)]), {
      ...fakeTime(),
      maxAttempts: 1,
      fallbacks: [scripted("b", ["fb"])],
    })
    const result = await withRetry(inner, fakeTime()).invoke("x", ctx())
    expect(result.value).toBe("fb:x")
    expect(report(result.meta)).toEqual({
      served: "b",
      position: 0,
      attempts: 2,
      fellBackFrom: ["a"],
      waitedMs: 0,
    })
  })
})

// ── Classification helpers ───────────────────────────────────────────────────

describe("defaultRetryClassifier", () => {
  it.each([
    [apiError(429), "retry"],
    [apiError(408), "retry"],
    [apiError(500), "retry"],
    [apiError(529), "retry"],
    [apiError(501), "fatal"],
    [apiError(505), "fatal"],
    [new RetryExhaustedError([], "exhausted", undefined), "fallback"],
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
