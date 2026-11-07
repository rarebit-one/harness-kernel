import { describe, it, expect } from "vitest"
import {
  SuspendedRunError,
  remainingLimits,
  runAgent,
  runConversation,
  withToolResults,
} from "./agent.js"
import { recordRunEvents } from "./events.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult, ToolCall, ToolResult } from "./providers/types.js"
import { terminalTool } from "./tools/terminal.js"
import type { Tool } from "./tools/registry.js"

/** Runs on the caller's side: the loop parks it. */
const askHuman: Tool = {
  spec: { name: "ask_human", description: "ask a person", inputSchema: { type: "object" } },
  meta: { dispatch: "external", replay: "safe" },
  execute: async () => {
    throw new Error("an external tool's executor must never run in the loop")
  },
}
/** The same tool, answered in-process: the reference transcript to compare against. */
const askHumanInline: Tool = {
  spec: askHuman.spec,
  execute: async () => "yes",
}
const echo: Tool = {
  spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
  execute: async (input) => `echoed ${JSON.stringify(input)}`,
}
const reply = terminalTool({
  name: "reply",
  description: "final answer",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
})

const prose = (text: string): ConverseResult => ({ text, toolCalls: [] })
const call = (name: string, id: string, input: Record<string, unknown> = {}): ConverseResult => ({
  text: "",
  toolCalls: [{ id, name, input, argumentsText: JSON.stringify(input) }],
})
const calls = (...cs: ConverseResult[]): ConverseResult => ({
  text: "",
  toolCalls: cs.flatMap((c) => c.toolCalls),
})
const seed: AgentMessage[] = [{ role: "user", text: "may I?" }]
const answer = (id: string, content = "yes"): ToolResult => ({ toolCallId: id, content })

describe("suspend on an external tool", () => {
  it("parks the call, ends suspended, and reports what it consumed", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1", { q: "ok?" })])
    const { sink, events } = recordRunEvents()

    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman, echo],
      emit: sink,
    })

    expect(result.outcome).toBe("suspended")
    expect(result.stopReason).toBe("suspended")
    expect(result.pending).toEqual([
      {
        id: "h1",
        name: "ask_human",
        input: { q: "ok?" },
        argumentsText: '{"q":"ok?"}',
        external: true,
      },
    ])
    // The transcript ends with the unanswered assistant turn: nothing was run.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(result.consumed.steps).toBe(1)
    expect(result.consumed.durationMs).toBeGreaterThanOrEqual(0)
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.pending",
      "run.finished",
    ])
    expect(events[2]).toMatchObject({ callId: "h1", name: "ask_human", input: { q: "ok?" } })
    expect(events[3]).toMatchObject({ outcome: "suspended", stopReason: "suspended", steps: 1 })
    expect(provider.remaining).toBe(0)
  })

  it("parks several external calls from one step", async () => {
    const provider = new ScriptedProvider([calls(call("ask_human", "h1"), call("ask_human", "h2"))])
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })

    expect(result.outcome).toBe("suspended")
    expect(result.pending?.map((c) => c.id)).toEqual(["h1", "h2"])
  })

  it("runs the server-side calls of a mixed step now and parks only the external ones", async () => {
    const provider = new ScriptedProvider([
      calls(call("echo", "e1", { v: 1 }), call("ask_human", "h1")),
      prose("done"),
    ])
    const { sink, events } = recordRunEvents()

    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman, echo],
      emit: sink,
    })
    expect(first.pending?.map((c) => c.id)).toEqual(["h1"])
    // echo's result is already in the transcript; the parked call's is not.
    const tail = first.messages[first.messages.length - 1]
    expect(tail).toEqual({
      role: "tool",
      results: [{ toolCallId: "e1", content: 'echoed {"v":1}' }],
    })
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.called",
      "tool.succeeded",
      "tool.pending",
      "run.finished",
    ])

    // Resume: the caller's answer joins the SAME tool turn, so one tool turn
    // still answers one assistant turn.
    const resumed = withToolResults(first.messages, [answer("h1")])
    expect(resumed[resumed.length - 1]).toEqual({
      role: "tool",
      results: [
        { toolCallId: "e1", content: 'echoed {"v":1}' },
        { toolCallId: "h1", content: "yes" },
      ],
    })
    const { sink: sink2, events: events2 } = recordRunEvents()
    const second = await runConversation({
      provider,
      system: "s",
      messages: resumed,
      tools: [askHuman, echo],
      emit: sink2,
    })
    expect(second.outcome).toBe("completed")
    expect(second.text).toBe("done")
    // The resumed stream closes the parked call before its first turn.
    expect(events2.slice(0, 3).map((e) => e.type)).toEqual([
      "run.started",
      "tool.succeeded",
      "model.turn",
    ])
    expect(events2[1]).toMatchObject({ callId: "h1", name: "ask_human", step: 0, replay: "safe" })
    expect(provider.remaining).toBe(0)
  })

  it("reports a rejected call as tool.failed with reason rejected, not threw", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1"), prose("understood")])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })
    const { sink, events } = recordRunEvents()

    const second = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [
        { toolCallId: "h1", content: "declined by policy", isError: true, rejected: true },
      ]),
      tools: [askHuman],
      emit: sink,
    })

    expect(second.outcome).toBe("completed")
    expect(events[1]).toMatchObject({
      type: "tool.failed",
      reason: "rejected",
      callId: "h1",
      error: "declined by policy",
    })
    // The model saw the rejection as an ordinary error result.
    expect(provider.requests[1]?.messages[provider.requests[1].messages.length - 1]).toEqual({
      role: "tool",
      results: [{ toolCallId: "h1", content: "declined by policy", isError: true, rejected: true }],
    })
  })

  it("carries the budget across the suspension, and the first resumed step always runs", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1"), prose("done")])
    const { sink, events } = recordRunEvents()
    const limits = { maxSteps: 1, maxDurationMs: 5_000 }

    // Parked on the LAST allowed step: that is a suspension, not exhaustion.
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
      ...limits,
      emit: sink,
    })
    expect(first.outcome).toBe("suspended")
    expect(events.some((e) => e.type === "run.budget_exhausted")).toBe(false)

    const left = remainingLimits(limits, first.consumed)
    // Nothing left on paper; the floor still grants the resumed step.
    expect(left.maxSteps).toBe(1)
    expect(left.maxDurationMs).toBeGreaterThanOrEqual(60_000)

    const second = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [answer("h1")]),
      tools: [askHuman],
      maxSteps: left.maxSteps,
      maxDurationMs: left.maxDurationMs,
    })
    expect(second.outcome).toBe("completed")
    expect(second.text).toBe("done")
    expect(
      remainingLimits({ maxSteps: 12, maxDurationMs: 600_000 }, { steps: 4, durationMs: 90_000 }),
    ).toEqual({
      maxSteps: 8,
      maxDurationMs: 510_000,
    })
  })

  it("survives JSON and resumes to the transcript an uninterrupted run produces", async () => {
    const script = () => [call("ask_human", "h1", { q: "ok?" }), prose("thanks")]
    const reference = await runConversation({
      provider: new ScriptedProvider(script()),
      system: "s",
      messages: seed,
      tools: [askHumanInline],
    })

    const provider = new ScriptedProvider(script())
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })
    const stored = JSON.parse(
      JSON.stringify({ messages: first.messages, pending: first.pending }),
    ) as { messages: AgentMessage[]; pending: ToolCall[] }
    const second = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(stored.messages, [answer(stored.pending[0]!.id)]),
      tools: [askHuman],
    })

    // Identical but for the provenance mark the loop leaves on the parked call.
    const unmarked = second.messages.map((m) =>
      m.role === "assistant"
        ? { ...m, toolCalls: m.toolCalls.map(({ external: _, ...c }) => c) }
        : m,
    )
    expect(unmarked).toEqual(reference.messages)
    expect(second.text).toBe(reference.text)
  })

  it("refuses a resume seed that leaves a pending call unanswered", async () => {
    const provider = new ScriptedProvider([
      calls(call("ask_human", "h1"), call("ask_human", "h2")),
      prose("unreachable"),
    ])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })
    await expect(
      runConversation({
        provider,
        system: "s",
        messages: withToolResults(first.messages, [answer("h1")]),
        tools: [askHuman],
      }),
    ).rejects.toThrow(/unanswered call ids: h2/)
    expect(provider.remaining).toBe(1)
  })

  it("closes the parked call on resume even when its tool was dropped from the tool set", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1"), prose("ok")])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })
    const { sink, events } = recordRunEvents()

    const second = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [answer("h1")]),
      tools: [echo],
      emit: sink,
    })

    expect(second.outcome).toBe("completed")
    expect(events[1]).toMatchObject({ type: "tool.succeeded", callId: "h1", name: "ask_human" })
  })

  it("does not re-close a server-side call whose tool was dropped on resume", async () => {
    const provider = new ScriptedProvider([
      calls(call("echo", "e1", { v: 1 }), call("ask_human", "h1")),
      prose("ok"),
    ])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman, echo],
    })
    const { sink, events } = recordRunEvents()

    await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [answer("h1")]),
      tools: [],
      emit: sink,
    })

    // Only the parked call is closed here; echo closed in the first run.
    const closes = events.filter((e) => e.type === "tool.succeeded" || e.type === "tool.failed")
    expect(closes.map((e) => "callId" in e && e.callId)).toEqual(["h1"])
  })

  it("reports a failed external execution as tool.failed with reason threw", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1"), prose("ok")])
    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman],
    })
    const { sink, events } = recordRunEvents()

    await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [
        { toolCallId: "h1", content: "device unreachable", isError: true },
      ]),
      tools: [askHuman],
      emit: sink,
    })

    expect(events[1]).toMatchObject({ type: "tool.failed", reason: "threw", callId: "h1" })
    expect(events.some((e) => e.type === "tool.succeeded")).toBe(false)
  })

  it("refuses to hand a single-shot caller a suspended run as an answer", async () => {
    const provider = new ScriptedProvider([call("ask_human", "h1")])
    const err = await runAgent({ provider, system: "s", userPrompt: "may I?", tools: [askHuman] })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SuspendedRunError)
    if (!(err instanceof SuspendedRunError)) throw new Error("unreachable")
    expect(err.result.outcome).toBe("suspended")
    expect(err.result.pending?.map((c) => c.id)).toEqual(["h1"])
    expect(err.result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("lets a terminal answer in the same step end the run; the parked call is answered as not run", async () => {
    const provider = new ScriptedProvider([
      calls(call("ask_human", "h1"), call("reply", "r1", { text: "42" })),
    ])
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman, reply],
      emit: sink,
    })
    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("terminal_tool")
    expect(result.pending).toBeUndefined()
    // The stream closes the parked call itself: no resumed run will.
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.pending",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "run.finished",
    ])
    expect(events[5]).toMatchObject({ callId: "h1", reason: "aborted" })
    // Closed by this run, so the transcript no longer marks it as parked, and a
    // continuation does not close it again.
    const assistant = result.messages.find((m) => m.role === "assistant")
    expect(assistant?.role === "assistant" && assistant.toolCalls[0]?.external).toBeUndefined()
    const provider2 = new ScriptedProvider([prose("later")])
    const { sink: sink2, events: events2 } = recordRunEvents()
    await runConversation({
      provider: provider2,
      system: "s",
      messages: [...result.messages, { role: "user", text: "go on" }],
      tools: [askHuman, reply],
      emit: sink2,
    })
    expect(events2.map((e) => e.type)).toEqual(["run.started", "model.turn", "run.finished"])
    const tail = result.messages[result.messages.length - 1]
    expect(tail).toMatchObject({
      role: "tool",
      results: [
        { toolCallId: "r1", content: "accepted" },
        { toolCallId: "h1", isError: true, content: expect.stringContaining("not run") as string },
      ],
    })
  })
})

describe("budget visibility", () => {
  it("is off by default and never written into the transcript", async () => {
    const provider = new ScriptedProvider([call("echo", "e1"), prose("done")])
    const result = await runConversation({ provider, system: "s", messages: seed, tools: [echo] })
    for (const req of provider.requests) {
      expect(req.messages.some((m) => m.role === "user" && m.text.startsWith("[budget]"))).toBe(
        false,
      )
    }
    expect(result.messages.some((m) => m.role === "user" && m.text.startsWith("[budget]"))).toBe(
      false,
    )
  })

  it("appends one ephemeral line per request when on, counting down the steps", async () => {
    const provider = new ScriptedProvider([call("echo", "e1"), prose("done")])
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [echo],
      maxSteps: 3,
      maxDurationMs: 120_000,
      budgetVisible: true,
    })
    const lines = provider.requests.map((req) => {
      const last = req.messages[req.messages.length - 1]
      return last?.role === "user" ? last.text : last?.role
    })
    expect(lines[0]).toMatch(/^\[budget\] 3 of 3 step\(s\) and 1[12]\ds remain/)
    expect(lines[1]).toMatch(/^\[budget\] 2 of 3 step\(s\)/)
    // The request carried it; the stored transcript did not.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    // The system prompt is untouched, so the cached prefix survives.
    expect(provider.requests.every((req) => req.system === "s")).toBe(true)
  })
})
