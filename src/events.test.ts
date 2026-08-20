import { describe, it, expect } from "vitest"
import { runAgent } from "./agent.js"
import { recordRunEvents, runEventEmitter, type RunEvent } from "./events.js"
import type { ConverseRequest, ConverseResult, Provider } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"

/** Calls `calls` tools on the first turn, then finishes with prose. */
class ScriptedProvider implements Provider {
  readonly name = "scripted"
  private turns = 0

  constructor(private readonly calls: { id: string; name: string }[]) {}

  async complete(): Promise<string> {
    return ""
  }

  async converse(_req: ConverseRequest): Promise<ConverseResult> {
    this.turns += 1
    if (this.turns === 1) {
      return { text: "thinking", toolCalls: this.calls.map((c) => ({ ...c, input: { v: 1 } })) }
    }
    return { text: "done", toolCalls: [] }
  }
}

/** Never stops calling tools — drives the loop into its step budget. */
class LoopingProvider implements Provider {
  readonly name = "looping"
  async complete(): Promise<string> {
    return ""
  }
  async converse(): Promise<ConverseResult> {
    return { text: "again", toolCalls: [{ id: "t", name: "ok", input: {} }] }
  }
}

const okTool: Tool = {
  spec: { name: "ok", description: "ok", inputSchema: { type: "object" } },
  execute: async () => "fine",
}

const boomTool: Tool = {
  spec: { name: "boom", description: "boom", inputSchema: { type: "object" } },
  execute: async () => {
    throw new Error("kaboom")
  },
}

const undoableTool: Tool = {
  spec: { name: "undoable", description: "undoable", inputSchema: { type: "object" } },
  meta: { reversible: true, undoToolName: "undo_it", undoWindowSeconds: 300 },
  execute: async () => "did it",
}

/** Rejects on the Nth turn, to exercise the loop's failure path. */
class RejectingProvider implements Provider {
  readonly name = "rejecting"
  async complete(): Promise<string> {
    return ""
  }
  async converse(): Promise<ConverseResult> {
    throw new Error("provider is down")
  }
}

/** Mutates the input it is handed — the sink an observer must not be able to be. */
const mutatingTool: Tool = {
  spec: { name: "ok", description: "ok", inputSchema: { type: "object" } },
  execute: async (input) => JSON.stringify(input),
}

const types = (events: RunEvent[]): string[] => events.map((e) => e.type)

describe("runEventEmitter", () => {
  it("stamps a gapless monotonic sequence", () => {
    const { sink, events } = recordRunEvents()
    const emitter = runEventEmitter(sink)
    emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 0 })
    emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 1 })
    emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 2 })

    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(emitter.count).toBe(3)
  })

  it("advances the sequence with no sink, so attaching one later cannot renumber", () => {
    const emitter = runEventEmitter(undefined)
    emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 0 })
    emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 1 })
    expect(emitter.count).toBe(2)
  })

  it("isolates a throwing sink and reports it through log", () => {
    const lines: string[] = []
    const emitter = runEventEmitter(
      () => {
        throw new Error("sink is down")
      },
      (l) => lines.push(l),
    )

    expect(() =>
      emitter.emit({ type: "run.budget_exhausted", kind: "steps", step: 0 }),
    ).not.toThrow()
    expect(lines.join("\n")).toContain("sink is down")
  })
})

describe("runAgent event stream", () => {
  it("emits started → turn → called → succeeded → finished in order", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      emit: sink,
    })

    expect(types(events)).toEqual([
      "run.started",
      "model.turn",
      "tool.called",
      "tool.succeeded",
      "model.turn",
      "run.finished",
    ])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("declares the tool surface and the resolved budgets on run.started", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([]),
      system: "s",
      userPrompt: "go",
      tools: [okTool, undoableTool],
      maxSteps: 4,
      maxDurationMs: 5_000,
      emit: sink,
    })

    const started = events[0]
    expect(started).toMatchObject({
      type: "run.started",
      maxSteps: 4,
      maxDurationMs: 5_000,
      tools: ["ok", "undoable"],
    })
  })

  it("carries the tool's own reversibility metadata on tool.succeeded", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "undoable" }]),
      system: "s",
      userPrompt: "go",
      tools: [undoableTool],
      emit: sink,
    })

    expect(events.find((e) => e.type === "tool.succeeded")).toMatchObject({
      name: "undoable",
      reversible: true,
      undoToolName: "undo_it",
      undoWindowSeconds: 300,
    })
  })

  it("omits reversibility rather than guessing when a tool declares none", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      emit: sink,
    })

    const ok = events.find((e) => e.type === "tool.succeeded")
    // Absent, never `false` — "makes no claim" and "declared irreversible" are
    // different facts, and a rollback consumer must be able to tell them apart.
    expect(ok && "reversible" in ok).toBe(false)
  })

  it("emits tool.called before the tool runs, so a mid-tool crash leaves evidence", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "boom" }]),
      system: "s",
      userPrompt: "go",
      tools: [boomTool],
      emit: sink,
    })

    const called = events.findIndex((e) => e.type === "tool.called")
    const failed = events.findIndex((e) => e.type === "tool.failed")
    expect(called).toBeGreaterThanOrEqual(0)
    expect(failed).toBeGreaterThan(called)
    expect(events[failed]).toMatchObject({ reason: "threw", error: "kaboom" })
  })

  it("distinguishes a hallucinated tool name from a tool that threw", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "nope" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      emit: sink,
    })

    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({ reason: "unknown_tool" })
    // No effect can have started, so there must be no tool.called for it.
    expect(events.some((e) => e.type === "tool.called")).toBe(false)
  })

  it("reports steps_exhausted rather than completed when the step budget ran out", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new LoopingProvider(),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      maxSteps: 2,
      emit: sink,
    })

    expect(events.some((e) => e.type === "run.budget_exhausted" && e.kind === "steps")).toBe(true)
    const finished = events[events.length - 1]
    expect(finished).toMatchObject({ type: "run.finished", outcome: "steps_exhausted", steps: 2 })
  })

  it("reports timed_out and stops when the wall-clock budget is already spent", async () => {
    const { sink, events } = recordRunEvents()
    const text = await runAgent({
      provider: new LoopingProvider(),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      maxDurationMs: -1, // already past the deadline on entry
      emit: sink,
    })

    expect(events.some((e) => e.type === "run.budget_exhausted" && e.kind === "duration")).toBe(
      true,
    )
    expect(events[events.length - 1]).toMatchObject({ type: "run.finished", outcome: "timed_out" })
    expect(text).toContain("wall-clock budget")
  })

  it("does not fail the run when the sink throws — and the run still returns its answer", async () => {
    const lines: string[] = []
    const text = await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      log: (l) => lines.push(l),
      emit: () => {
        throw new Error("sink exploded")
      },
    })

    expect(text).toBe("done")
    expect(lines.join("\n")).toContain("sink exploded")
  })

  it("hands the sink a DETACHED copy, so a mutating sink cannot change the tool's input", async () => {
    let seen: unknown
    const text = await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [
        {
          ...mutatingTool,
          execute: async (input) => {
            seen = structuredClone(input)
            return "fine"
          },
        },
      ],
      emit: (e) => {
        // A redacting sink, written the obvious (wrong) way: in place.
        if (e.type === "tool.called") {
          e.input.v = "REDACTED"
          e.input.injected = true
        }
      },
    })

    expect(text).toBe("done")
    // The tool must see what the model actually sent, not the sink's edit.
    expect(seen).toEqual({ v: 1 })
  })

  it("detaches nested input too, not just the top level", async () => {
    let seen: unknown
    class NestedProvider implements Provider {
      readonly name = "nested"
      private turns = 0
      async complete(): Promise<string> {
        return ""
      }
      async converse(): Promise<ConverseResult> {
        this.turns += 1
        if (this.turns === 1) {
          return { text: "", toolCalls: [{ id: "t1", name: "ok", input: { deep: { a: 1 } } }] }
        }
        return { text: "done", toolCalls: [] }
      }
    }

    await runAgent({
      provider: new NestedProvider(),
      system: "s",
      userPrompt: "go",
      tools: [
        {
          ...mutatingTool,
          execute: async (input) => {
            seen = structuredClone(input)
            return "fine"
          },
        },
      ],
      emit: (e) => {
        if (e.type === "tool.called") {
          ;(e.input.deep as Record<string, unknown>).a = 999
        }
      },
    })

    expect(seen).toEqual({ deep: { a: 1 } })
  })

  it("carries undo metadata on tool.called, not only on success", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "undoable" }]),
      system: "s",
      userPrompt: "go",
      tools: [undoableTool],
      emit: sink,
    })

    // The half-applied-then-threw case only has tool.called to work from, so
    // undo metadata must already be on it.
    expect(events.find((e) => e.type === "tool.called")).toMatchObject({
      reversible: true,
      undoToolName: "undo_it",
      undoWindowSeconds: 300,
    })
  })

  it("closes the stream with outcome failed when the model rejects, and rethrows", async () => {
    const { sink, events } = recordRunEvents()

    await expect(
      runAgent({
        provider: new RejectingProvider(),
        system: "s",
        userPrompt: "go",
        tools: [okTool],
        emit: sink,
      }),
    ).rejects.toThrow("provider is down")

    // A run.started with no terminal event is indistinguishable from a run
    // still in flight — the whole reason this path emits.
    const last = events[events.length - 1]
    expect(last).toMatchObject({
      type: "run.finished",
      outcome: "failed",
      error: "provider is down",
    })
  })

  it("emits a model.turn for the step-budget summary call", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new LoopingProvider(),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      maxSteps: 2,
      emit: sink,
    })

    // Two loop turns plus the tools-free summary invocation.
    expect(events.filter((e) => e.type === "model.turn")).toHaveLength(3)
    expect(events[events.length - 1]).toMatchObject({ type: "run.finished" })
  })

  it("reports tool output size in UTF-8 bytes, not UTF-16 code units", async () => {
    const { sink, events } = recordRunEvents()
    const emoji = "🐙🐙" // 4 UTF-16 code units, 8 UTF-8 bytes
    await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [{ ...okTool, execute: async () => emoji }],
      emit: sink,
    })

    expect(events.find((e) => e.type === "tool.succeeded")).toMatchObject({ bytes: 8 })
    expect(emoji.length).toBe(4) // the value the naive implementation would report
  })

  it("behaves identically with no sink at all", async () => {
    const withSink = await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
      emit: recordRunEvents().sink,
    })
    const without = await runAgent({
      provider: new ScriptedProvider([{ id: "t1", name: "ok" }]),
      system: "s",
      userPrompt: "go",
      tools: [okTool],
    })

    expect(withSink).toBe(without)
  })
})
