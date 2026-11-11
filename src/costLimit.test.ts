import { describe, it, expect } from "vitest"
import {
  remainingLimits,
  resolveLoopLimits,
  runAgent,
  runConversation,
  withToolResults,
} from "./agent.js"
import { recordRunEvents } from "./events.js"
import { chatModel } from "./models/chat.js"
import { withMiddleware, type Middleware } from "./models/middleware.js"
import type { TokenUsage } from "./models/types.js"
import { privateRunChannels } from "./private.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"

const usd = (amount: number): TokenUsage => ({
  inputTokens: 10,
  outputTokens: 5,
  reportedCost: { amount, currency: "USD" },
})
const prose = (text: string, usage?: TokenUsage): ConverseResult => ({
  text,
  toolCalls: [],
  ...(usage ? { usage } : {}),
})
const call = (name: string, id: string, usage?: TokenUsage, text = ""): ConverseResult => ({
  text,
  toolCalls: [{ id, name, input: {}, argumentsText: "{}" }],
  ...(usage ? { usage } : {}),
})
const seed: AgentMessage[] = [{ role: "user", text: "go" }]

/** An in-process tool that counts how often it actually ran. */
function counted(name: string): Tool & { runs: number } {
  const tool = {
    runs: 0,
    spec: { name, description: name, inputSchema: { type: "object" } },
    execute: async () => {
      tool.runs += 1
      return "ok"
    },
  }
  return tool
}
const askHuman: Tool = {
  spec: { name: "ask_human", description: "ask a person", inputSchema: { type: "object" } },
  meta: { dispatch: "external" },
  execute: async () => {
    throw new Error("an external tool's executor must never run in the loop")
  },
}

describe("resolveLoopLimits: the cost budget", () => {
  it("has no default: absent stays absent", () => {
    expect(resolveLoopLimits({ maxSteps: 3, maxDurationMs: 1_000 })).toEqual({
      maxSteps: 3,
      maxDurationMs: 1_000,
    })
    expect("maxCostUsd" in resolveLoopLimits()).toBe(false)
  })

  it("passes a set limit through, zero included", () => {
    expect(resolveLoopLimits({ maxCostUsd: 0.5 }).maxCostUsd).toBe(0.5)
    expect(resolveLoopLimits({ maxCostUsd: 0 }).maxCostUsd).toBe(0)
  })

  it("refuses a limit that could never be compared honestly", () => {
    expect(() => resolveLoopLimits({ maxCostUsd: Number.NaN })).toThrow(RangeError)
    expect(() => resolveLoopLimits({ maxCostUsd: -1 })).toThrow(/non-negative/)
  })
})

describe("the cost budget in the loop", () => {
  it("changes nothing when absent, however much the run reports", async () => {
    const echo = counted("echo")
    const provider = new ScriptedProvider(
      [call("echo", "e1", usd(5)), call("echo", "e2", usd(5)), prose("done", usd(5))],
      { reportsUsage: true },
    )
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [echo],
      emit: sink,
    })

    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("end_turn")
    expect(echo.runs).toBe(2)
    expect(result.usage?.reportedCost).toEqual({ amount: 15, currency: "USD" })
    expect(events.some((e) => e.type === "run.budget_exhausted")).toBe(false)
    const started = events.find((e) => e.type === "run.started")
    expect(started && "maxCostUsd" in started).toBe(false)
  })

  it("stops before running the tools of the turn that reached it, with no summary call", async () => {
    const echo = counted("echo")
    const provider = new ScriptedProvider(
      [
        call("echo", "e1", usd(0.3), "working"),
        // Reaches the budget (0.6 >= 0.5) while asking for an in-process tool
        // and an external one: neither may start, and nothing is parked.
        {
          text: "more",
          toolCalls: [
            { id: "e2", name: "echo", input: {}, argumentsText: "{}" },
            { id: "h1", name: "ask_human", input: {}, argumentsText: "{}" },
          ],
          usage: usd(0.3),
        },
        prose("never asked for"),
      ],
      { reportsUsage: true },
    )
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [echo, askHuman],
      maxCostUsd: 0.5,
      emit: sink,
    })

    expect(result.outcome).toBe("cost_exhausted")
    expect(result.stopReason).toBe("cost_exhausted")
    expect(result.steps).toBe(2)
    expect(echo.runs).toBe(1)
    // No summary turn: the unplayed script turn proves the loop asked for nothing more.
    expect(provider.remaining).toBe(1)
    expect(result.pending).toBeUndefined()
    expect(result.text).toBe("more\n\n[run stopped: cost budget of 0.5 USD reached]")
    expect(result.consumed.usage?.reportedCost?.amount).toBeCloseTo(0.6)
    // Every call of the stopped turn is answered, so the transcript resumes.
    const last = result.messages[result.messages.length - 1]
    expect(last?.role).toBe("tool")
    expect(last?.role === "tool" && last.results.map((r) => [r.toolCallId, r.isError])).toEqual([
      ["e2", true],
      ["h1", true],
    ])
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.called",
      "tool.succeeded",
      "model.turn",
      "run.budget_exhausted",
      "run.finished",
    ])
    expect(events.find((e) => e.type === "run.started")).toMatchObject({ maxCostUsd: 0.5 })
    expect(events.find((e) => e.type === "run.budget_exhausted")).toMatchObject({
      kind: "cost",
      step: 1,
    })
    expect(events[events.length - 1]).toMatchObject({
      type: "run.finished",
      outcome: "cost_exhausted",
      stopReason: "cost_exhausted",
      steps: 2,
    })
  })

  it("lets a prose answer on the turn that reached it complete as usual", async () => {
    const provider = new ScriptedProvider([prose("the answer", usd(2))], { reportsUsage: true })
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [],
      maxCostUsd: 1,
    })

    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("end_turn")
    expect(result.text).toBe("the answer")
  })

  it("resolves runAgent with the noted prose instead of throwing", async () => {
    const provider = new ScriptedProvider([call("echo", "e1", usd(1), "partial")], {
      reportsUsage: true,
    })
    const text = await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [counted("echo")],
      maxCostUsd: 1,
    })
    expect(text).toBe("partial\n\n[run stopped: cost budget of 1 USD reached]")
  })

  it("counts only reported cost: unpriced turns neither stop the run nor count as free", async () => {
    const echo = counted("echo")
    const provider = new ScriptedProvider([call("echo", "e1"), call("echo", "e2"), prose("done")])
    const lines: string[] = []
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [echo],
      maxCostUsd: 0,
      log: (l) => lines.push(l),
    })

    expect(result.outcome).toBe("completed")
    expect(echo.runs).toBe(2)
    expect(result.usage).toBeUndefined()
    // Said once, not once per turn.
    expect(lines.filter((l) => l.includes("reported no cost"))).toHaveLength(1)
  })

  it("runs on the reported part when only some turns are priced", async () => {
    const echo = counted("echo")
    const provider = new ScriptedProvider(
      [call("echo", "e1"), call("echo", "e2", usd(0.4)), call("echo", "e3", usd(0.2))],
      { reportsUsage: true },
    )
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [echo],
      maxCostUsd: 0.5,
    })

    expect(result.outcome).toBe("cost_exhausted")
    expect(result.steps).toBe(3)
    expect(echo.runs).toBe(2)
  })

  it("covers unpriced calls when the caller prices them in a model middleware", async () => {
    // The kernel carries no price table. A caller that wants unreported calls
    // inside the limit prices them on the model seam; the loop sees the result
    // as reported cost like any other.
    const pricing: Middleware = {
      name: "pricing",
      invoke: (next) => async (req, ctx) => {
        const res = await next(req, ctx)
        const u = res.usage as TokenUsage | undefined
        if (!u || u.reportedCost) return res
        const amount = ((u.inputTokens ?? 0) + (u.outputTokens ?? 0)) * 0.01
        return { ...res, usage: { ...u, reportedCost: { amount, currency: "USD" } } }
      },
    }
    const unpriced: TokenUsage = { inputTokens: 40, outputTokens: 10 }
    const model = withMiddleware(
      chatModel(
        new ScriptedProvider([call("echo", "e1", unpriced), call("echo", "e2", unpriced)], {
          reportsUsage: true,
        }),
      ),
      [pricing],
    )
    const echo = counted("echo")
    const result = await runConversation({
      provider: model,
      system: "s",
      messages: seed,
      tools: [echo],
      maxCostUsd: 0.75,
    })

    expect(result.outcome).toBe("cost_exhausted")
    expect(result.steps).toBe(2)
    expect(echo.runs).toBe(1)
  })

  it("carries the remaining budget across a suspension", async () => {
    const echo = counted("echo")
    const provider = new ScriptedProvider(
      [call("ask_human", "h1", usd(0.4)), call("echo", "e1", usd(0.7)), prose("unreached")],
      { reportsUsage: true },
    )
    const limits = resolveLoopLimits({ maxSteps: 10, maxDurationMs: 60_000, maxCostUsd: 1 })

    const first = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [askHuman, echo],
      ...limits,
    })
    expect(first.outcome).toBe("suspended")

    const left = remainingLimits(limits, first.consumed)
    expect(left.maxCostUsd).toBeCloseTo(0.6)

    // 0.7 on its own is under the original 1.0, so only a carried budget stops it.
    const second = await runConversation({
      provider,
      system: "s",
      messages: withToolResults(first.messages, [{ toolCallId: "h1", content: "yes" }]),
      tools: [askHuman, echo],
      ...left,
    })
    expect(second.outcome).toBe("cost_exhausted")
    expect(echo.runs).toBe(0)
  })

  it("subtracts only what was reported, floors at zero, and leaves no limit absent", () => {
    const limits = { maxSteps: 12, maxDurationMs: 600_000, maxCostUsd: 1 }
    expect(remainingLimits(limits, { steps: 2, durationMs: 1_000 }).maxCostUsd).toBe(1)
    expect(remainingLimits(limits, { steps: 2, durationMs: 1_000, usage: usd(3) }).maxCostUsd).toBe(
      0,
    )
    expect(
      "maxCostUsd" in
        remainingLimits({ maxSteps: 12, maxDurationMs: 600_000 }, { steps: 2, durationMs: 1 }),
    ).toBe(false)
  })

  it("adds the cost left to the budget line, and only under a cost limit", async () => {
    const lineOf = (p: ScriptedProvider, i: number) => {
      const last = p.requests[i]?.messages.at(-1)
      return last?.role === "user" ? last.text : undefined
    }
    const withCost = new ScriptedProvider([call("echo", "e1", usd(0.25)), prose("done")], {
      reportsUsage: true,
    })
    await runConversation({
      provider: withCost,
      system: "s",
      messages: seed,
      tools: [counted("echo")],
      maxSteps: 3,
      maxDurationMs: 120_000,
      maxCostUsd: 1,
      budgetVisible: true,
    })
    expect(lineOf(withCost, 0)).toMatch(
      /^\[budget\] 3 of 3 step\(s\), 1[12]\ds and \$1\.0000 of cost remain\./,
    )
    expect(lineOf(withCost, 1)).toMatch(/^\[budget\] 2 of 3 step\(s\), .* and \$0\.7500 of cost/)

    const without = new ScriptedProvider([prose("done", usd(0.25))], { reportsUsage: true })
    await runConversation({
      provider: without,
      system: "s",
      messages: seed,
      tools: [],
      maxSteps: 3,
      maxDurationMs: 120_000,
      budgetVisible: true,
    })
    expect(lineOf(without, 0)).toMatch(/^\[budget\] 3 of 3 step\(s\) and 1[12]\ds remain\./)
  })

  it("keeps the cost stop visible through a private run's redaction", async () => {
    const lines: string[] = []
    const { sink, events } = recordRunEvents()
    const channels = privateRunChannels((l) => lines.push(l), sink)
    await runConversation({
      provider: new ScriptedProvider([call("echo", "e1", usd(1))], { reportsUsage: true }),
      system: "s",
      messages: seed,
      tools: [counted("echo")],
      maxCostUsd: 1,
      log: channels.log,
      emit: channels.emit,
    })

    expect(events.find((e) => e.type === "run.started")).toMatchObject({ maxCostUsd: 1 })
    expect(events.find((e) => e.type === "run.budget_exhausted")).toMatchObject({ kind: "cost" })
    expect(events.at(-1)).toMatchObject({ outcome: "cost_exhausted", stopReason: "cost_exhausted" })
    expect(lines).toContain("phase=run.budget_exhausted step=0 kind=cost")
  })
})
