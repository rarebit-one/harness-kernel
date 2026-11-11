import { describe, it, expect } from "vitest"
import { runConversation, withToolResults } from "./agent.js"
import { recordRunEvents, type RunEvent } from "./events.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult } from "./providers/types.js"
import { isConcurrencySafe } from "./tools/metadata.js"
import type { Tool, ToolContext } from "./tools/registry.js"
import type { ToolConcurrency } from "./tools/concurrency.js"

const prose = (text: string): ConverseResult => ({ text, toolCalls: [] })
const calls = (...cs: Array<[name: string, id: string]>): ConverseResult => ({
  text: "",
  toolCalls: cs.map(([name, id]) => ({ id, name, input: { id }, argumentsText: `{"id":"${id}"}` })),
})
const seed: AgentMessage[] = [{ role: "user", text: "go" }]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Records what was in flight, so overlap (or its absence) is observed rather than timed. */
function tracker() {
  let inFlight = 0
  const log: string[] = []
  const self = {
    log,
    maxInFlight: 0,
    /** A tool that sleeps `ms` (per call id when a map is given), honouring the run's signal. */
    tool(
      name: string,
      opts: {
        ms?: number | Record<string, number>
        safe?: boolean
        fail?: boolean
        dispatch?: "terminal"
      } = {},
    ): Tool {
      return {
        spec: { name, description: name, inputSchema: { type: "object" } },
        meta: {
          ...(opts.safe ? { concurrencySafe: true } : {}),
          ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
        },
        async execute(input, ctx?: ToolContext) {
          const id = String(input.id)
          inFlight += 1
          self.maxInFlight = Math.max(self.maxInFlight, inFlight)
          log.push(`start ${id}`)
          try {
            const ms = typeof opts.ms === "object" ? (opts.ms[id] ?? 0) : (opts.ms ?? 0)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, ms)
              ctx?.signal.addEventListener("abort", () => {
                clearTimeout(timer)
                // The signal's own reason, as a well-behaved tool would surface it.
                reject(ctx.signal.reason as Error)
              })
            })
            if (opts.fail) throw new Error(`${id} broke`)
            return `${name}:${id}`
          } finally {
            inFlight -= 1
            log.push(`end ${id}`)
          }
        },
      }
    },
  }
  return self
}

const parallel = (maxConcurrent: number): ToolConcurrency => ({
  maxConcurrent,
  concurrencySafe: isConcurrencySafe,
})

/** The tool turn the loop appended for the first step. */
function toolTurn(messages: AgentMessage[]) {
  const turn = messages.find((m) => m.role === "tool")
  if (turn?.role !== "tool") throw new Error("no tool turn")
  return turn.results
}

function types(events: RunEvent[]): string[] {
  return events.map((e) => ("callId" in e ? `${e.type} ${e.callId}` : e.type))
}

describe("parallel tool calls", () => {
  it("runs in series by default, even for tools that declare themselves safe", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 5 })
    const result = await runConversation({
      provider: new ScriptedProvider([calls(["read", "a"], ["read", "b"]), prose("done")]),
      system: "s",
      messages: seed,
      tools: [read],
    })
    expect(result.outcome).toBe("completed")
    expect(t.maxInFlight).toBe(1)
    expect(t.log).toEqual(["start a", "end a", "start b", "end b"])
  })

  it("runs safe calls together and returns results in the model's order", async () => {
    const t = tracker()
    // The first call is the slowest, so completion order is the reverse of call order.
    const read = t.tool("read", { safe: true, ms: { a: 30, b: 15, c: 1 } })
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(["read", "a"], ["read", "b"], ["read", "c"]),
        prose("done"),
      ]),
      system: "s",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(8),
      emit: sink,
    })

    expect(result.outcome).toBe("completed")
    expect(t.maxInFlight).toBe(3)
    expect(toolTurn(result.messages).map((r) => [r.toolCallId, r.content])).toEqual([
      ["a", "read:a"],
      ["b", "read:b"],
      ["c", "read:c"],
    ])
    // Every call is announced, in the model's order, before any effect lands;
    // each closes when it actually finished.
    expect(types(events).slice(2, 8)).toEqual([
      "tool.called a",
      "tool.called b",
      "tool.called c",
      "tool.succeeded c",
      "tool.succeeded b",
      "tool.succeeded a",
    ])
    // The stream stays gapless and monotonic however the calls interleaved.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  })

  it("never has more calls in flight than the cap, and starts them in order", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 5 })
    const ids = ["a", "b", "c", "d", "e"]
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(...ids.map((id) => ["read", id] as [string, string])),
        prose("ok"),
      ]),
      system: "s",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(2),
    })
    expect(t.maxInFlight).toBe(2)
    expect(t.log.filter((l) => l.startsWith("start"))).toEqual(ids.map((id) => `start ${id}`))
    expect(toolTurn(result.messages).map((r) => r.toolCallId)).toEqual(ids)
  })

  it("rejects a cap it cannot honour before calling the model", async () => {
    for (const maxConcurrent of [0, -1, 1.5, Number.NaN]) {
      const provider = new ScriptedProvider([prose("never")])
      await expect(
        runConversation({
          provider,
          system: "s",
          messages: seed,
          tools: [],
          toolConcurrency: { maxConcurrent, concurrencySafe: () => true },
        }),
      ).rejects.toThrow(/maxConcurrent must be a positive integer/)
      expect(provider.remaining).toBe(1)
    }
  })

  it("keeps an unsafe call between the calls around it, as in series", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 10 })
    const write = t.tool("write", { ms: 5 })
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(["read", "r1"], ["read", "r2"], ["write", "w"], ["read", "r3"], ["read", "r4"]),
        prose("done"),
      ]),
      system: "s",
      messages: seed,
      tools: [read, write],
      toolConcurrency: parallel(8),
    })

    // r1 and r2 overlap; the write starts only after both ended and ends
    // before r3 or r4 starts; r3 and r4 overlap.
    expect(t.log.slice(0, 2)).toEqual(["start r1", "start r2"])
    expect(t.log.slice(4, 6)).toEqual(["start w", "end w"])
    expect(t.log.slice(6, 8)).toEqual(["start r3", "start r4"])
    expect(toolTurn(result.messages).map((r) => r.toolCallId)).toEqual([
      "r1",
      "r2",
      "w",
      "r3",
      "r4",
    ])
  })

  it("lets the caller's predicate decide, not the metadata", async () => {
    const t = tracker()
    // No metadata claim at all; the run's own rule says these two may overlap.
    const lookup = t.tool("lookup", { ms: 10 })
    await runConversation({
      provider: new ScriptedProvider([calls(["lookup", "a"], ["lookup", "b"]), prose("ok")]),
      system: "s",
      messages: seed,
      tools: [lookup],
      toolConcurrency: { maxConcurrent: 4, concurrencySafe: (tool) => tool.spec.name === "lookup" },
    })
    expect(t.maxInFlight).toBe(2)
  })

  it("answers an unknown tool in a parallel step without blocking its siblings' results", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 1 })
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(["read", "a"], ["nope", "x"], ["read", "b"]),
        prose("ok"),
      ]),
      system: "s",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(4),
      emit: sink,
    })
    expect(toolTurn(result.messages)).toEqual([
      { toolCallId: "a", content: "read:a" },
      { toolCallId: "x", content: "unknown tool: nope", isError: true },
      { toolCallId: "b", content: "read:b" },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.failed", reason: "unknown_tool" }),
    )
  })

  it("reports a failing call beside succeeding ones without disturbing them", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 5 })
    const flaky = t.tool("flaky", { safe: true, ms: 1, fail: true })
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(["read", "a"], ["flaky", "f"], ["read", "b"]),
        prose("ok"),
      ]),
      system: "s",
      messages: seed,
      tools: [read, flaky],
      toolConcurrency: parallel(4),
      emit: sink,
    })
    expect(result.outcome).toBe("completed")
    expect(t.maxInFlight).toBe(3)
    expect(toolTurn(result.messages)).toEqual([
      { toolCallId: "a", content: "read:a" },
      { toolCallId: "f", content: "f broke", isError: true },
      { toolCallId: "b", content: "read:b" },
    ])
    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({
      callId: "f",
      reason: "threw",
      error: "f broke",
    })
  })

  it("stops on cancel mid-batch: in-flight calls abort, queued ones never start", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 10_000 })
    const controller = new AbortController()
    const { sink, events } = recordRunEvents()
    const run = runConversation({
      provider: new ScriptedProvider([calls(["read", "a"], ["read", "b"], ["read", "c"])]),
      system: "s",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(2),
      signal: controller.signal,
      emit: sink,
    })
    await sleep(20)
    controller.abort("user left")
    const result = await run

    expect(result.outcome).toBe("canceled")
    expect(t.log.filter((l) => l.startsWith("start"))).toEqual(["start a", "start b"])
    // Every call still has a result, so the transcript can be resumed.
    const results = toolTurn(result.messages)
    expect(results.map((r) => r.toolCallId)).toEqual(["a", "b", "c"])
    expect(results.every((r) => r.isError)).toBe(true)
    expect(results[2]?.content).toMatch(/^not run/)
    expect(types(events).filter((e) => e.startsWith("tool."))).toEqual([
      "tool.called a",
      "tool.called b",
      "tool.failed a",
      "tool.failed b",
    ])
    expect(events.filter((e) => e.type === "tool.failed")).toEqual([
      expect.objectContaining({ reason: "aborted" }),
      expect.objectContaining({ reason: "aborted" }),
    ])
  })

  it("stops on the deadline mid-batch with timed_out", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 10_000 })
    const result = await runConversation({
      provider: new ScriptedProvider([calls(["read", "a"], ["read", "b"], ["read", "c"])]),
      system: "s",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(2),
      maxDurationMs: 40,
    })
    expect(result.outcome).toBe("timed_out")
    expect(result.stopReason).toBe("timed_out")
    expect(t.log.filter((l) => l.startsWith("start"))).toEqual(["start a", "start b"])
    expect(toolTurn(result.messages).map((r) => r.toolCallId)).toEqual(["a", "b", "c"])
  })

  it("takes the first terminal call in the model's order as the answer, not the first to finish", async () => {
    const t = tracker()
    const answer = t.tool("answer", {
      safe: true,
      dispatch: "terminal",
      ms: { first: 25, second: 1 },
    })
    const read = t.tool("read", { safe: true, ms: 5 })
    const result = await runConversation({
      provider: new ScriptedProvider([
        calls(["answer", "first"], ["read", "r"], ["answer", "second"]),
      ]),
      system: "s",
      messages: seed,
      tools: [answer, read],
      toolConcurrency: parallel(4),
    })
    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("terminal_tool")
    expect(result.terminal?.callId).toBe("first")
    // The siblings still ran, so the transcript is whole.
    expect(toolTurn(result.messages).map((r) => r.toolCallId)).toEqual(["first", "r", "second"])
    expect(t.maxInFlight).toBe(3)
  })

  it("runs what it can in a batch and parks the external calls, in the model's order", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: { a: 15, b: 1 } })
    const ask: Tool = {
      spec: { name: "ask", description: "ask a person", inputSchema: { type: "object" } },
      // Safe to park beside the reads: parking runs nothing.
      meta: { dispatch: "external", concurrencySafe: true },
      execute: () =>
        Promise.reject(new Error("an external tool's executor must never run in the loop")),
    }
    const { sink, events } = recordRunEvents()
    const provider = new ScriptedProvider([
      calls(["read", "a"], ["ask", "h1"], ["read", "b"], ["ask", "h2"]),
      prose("thanks"),
    ])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [read, ask],
      toolConcurrency: parallel(4),
      emit: sink,
    })

    expect(first.outcome).toBe("suspended")
    expect(first.pending?.map((c) => c.id)).toEqual(["h1", "h2"])
    expect(toolTurn(first.messages).map((r) => r.toolCallId)).toEqual(["a", "b"])
    expect(types(events).filter((e) => e.startsWith("tool."))).toEqual([
      "tool.called a",
      "tool.pending h1",
      "tool.called b",
      "tool.pending h2",
      "tool.succeeded b",
      "tool.succeeded a",
    ])

    // The parked calls resume like any others.
    const resumed = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [
        { toolCallId: "h1", content: "yes" },
        { toolCallId: "h2", content: "no", rejected: true },
      ]),
      tools: [read, ask],
      toolConcurrency: parallel(4),
    })
    expect(resumed.outcome).toBe("completed")
    expect(resumed.text).toBe("thanks")
  })

  it("answers parked calls as not run when a parallel batch also produced a terminal answer", async () => {
    const t = tracker()
    const answer = t.tool("answer", { safe: true, dispatch: "terminal", ms: 5 })
    const ask: Tool = {
      spec: { name: "ask", description: "ask", inputSchema: { type: "object" } },
      meta: { dispatch: "external" },
      execute: () => Promise.reject(new Error("never")),
    }
    const result = await runConversation({
      provider: new ScriptedProvider([calls(["ask", "h"], ["answer", "z"])]),
      system: "s",
      messages: seed,
      tools: [answer, ask],
      toolConcurrency: parallel(4),
    })
    expect(result.stopReason).toBe("terminal_tool")
    expect(result.pending).toBeUndefined()
    expect(toolTurn(result.messages).map((r) => [r.toolCallId, r.isError ?? false])).toEqual([
      ["z", false],
      ["h", true],
    ])
  })
})
