import { describe, it, expect } from "vitest"
import { runAgent, resolveLoopLimits } from "./agent.js"
import { NativeEngine } from "./engines/native.js"
import type { RunSpec } from "./engines/types.js"
import { recordRunEvents, runEventEmitter } from "./events.js"
import { nativeLoop, runWithEvents, type Loop, type LoopRequest } from "./loop.js"
import { asChatModel } from "./models/chat.js"
import type { ConverseResult, Provider } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"

class ScriptedProvider implements Provider {
  readonly name = "scripted"
  private turns = 0
  async complete(): Promise<string> {
    return ""
  }
  async converse(): Promise<ConverseResult> {
    this.turns += 1
    if (this.turns === 1) {
      return { text: "", toolCalls: [{ id: "t1", name: "act", input: { v: 1 } }] }
    }
    return { text: "done", toolCalls: [] }
  }
}

/** Never stops asking for tools — runs into the step budget. */
class LoopingProvider implements Provider {
  readonly name = "looping"
  async complete(): Promise<string> {
    return ""
  }
  async converse(): Promise<ConverseResult> {
    return { text: "again", toolCalls: [{ id: "t", name: "act", input: {} }] }
  }
}

let ran: string[] = []

const actTool: Tool = {
  spec: { name: "act", description: "act", inputSchema: { type: "object" } },
  meta: { requiresConfirmation: true },
  execute: async () => {
    ran.push("act")
    return "acted"
  },
}

function request(provider: Provider, overrides: Partial<LoopRequest> = {}): LoopRequest {
  return {
    model: asChatModel(provider),
    system: "s",
    userPrompt: "go",
    tools: [actTool],
    limits: resolveLoopLimits(),
    ...overrides,
  }
}

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: {},
    inputs: {},
    context: "",
    workdir: "/tmp/x",
    permissions: {},
    secrets: {},
    connectors: [],
    provider: {},
    ...overrides,
  }
}

describe("nativeLoop", () => {
  it("returns the prose plus the two facts only the loop knows", async () => {
    const result = await nativeLoop.run(request(new ScriptedProvider()), {
      log: () => {},
      events: runEventEmitter(),
    })

    expect(result).toEqual({ text: "done", steps: 2, outcome: "completed" })
    expect(nativeLoop.name).toBe("native")
  })

  it("agrees with its own run.finished event — one run, not two sources of truth", async () => {
    const { sink, events } = recordRunEvents()
    const result = await runWithEvents(
      nativeLoop,
      request(new LoopingProvider(), { limits: resolveLoopLimits({ maxSteps: 2 }) }),
      { log: () => {}, events: runEventEmitter(sink) },
    )

    const finished = events[events.length - 1]
    expect(finished).toMatchObject({
      type: "run.finished",
      steps: result.steps,
      outcome: result.outcome,
      text: result.text,
    })
    expect(result.outcome).toBe("steps_exhausted")
  })

  it("is the same code path runAgent takes, so the two cannot drift", async () => {
    const viaLoop = await nativeLoop.run(request(new ScriptedProvider()), {
      log: () => {},
      events: runEventEmitter(),
    })
    const viaRunAgent = await runAgent({
      provider: new ScriptedProvider(),
      system: "s",
      userPrompt: "go",
      tools: [actTool],
    })

    expect(viaRunAgent).toBe(viaLoop.text)
  })
})

describe("runWithEvents", () => {
  const silent: Loop = {
    name: "silent",
    run: async () => ({ text: "quiet", steps: 4, outcome: "completed" }),
  }

  it("bookends a loop that emits NOTHING — the whole reason it exists", async () => {
    const { sink, events } = recordRunEvents()
    await runWithEvents(silent, request(new ScriptedProvider()), {
      log: () => {},
      events: runEventEmitter(sink),
    })

    expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"])
    expect(events[1]).toMatchObject({ outcome: "completed", steps: 4, text: "quiet" })
  })

  it("declares the run's real budgets and tool surface on the bookend", async () => {
    const { sink, events } = recordRunEvents()
    await runWithEvents(
      silent,
      request(new ScriptedProvider(), { limits: { maxSteps: 5, maxDurationMs: 50 } }),
      { log: () => {}, events: runEventEmitter(sink) },
    )

    expect(events[0]).toMatchObject({
      type: "run.started",
      maxSteps: 5,
      maxDurationMs: 50,
      tools: ["act"],
    })
  })

  it("closes the stream when ANY loop throws, and rethrows untouched", async () => {
    const boom = new Error("loop exploded")
    const failing: Loop = {
      name: "failing",
      run: async () => {
        throw boom
      },
    }
    const { sink, events } = recordRunEvents()

    await expect(
      runWithEvents(failing, request(new ScriptedProvider()), {
        log: () => {},
        events: runEventEmitter(sink),
      }),
      // The same error object, not a wrapper around it.
    ).rejects.toBe(boom)

    expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"])
    expect(events[1]).toMatchObject({ outcome: "failed", error: "loop exploded" })
  })

  it("OMITS steps and text on failure rather than inventing zeroes", async () => {
    const failing: Loop = {
      name: "failing",
      run: async () => {
        throw new Error("nope")
      },
    }
    const { sink, events } = recordRunEvents()
    await expect(
      runWithEvents(failing, request(new ScriptedProvider()), {
        log: () => {},
        events: runEventEmitter(sink),
      }),
    ).rejects.toThrow()

    const finished = events[1]
    // The loop never returned a result, so any number would be invented. The
    // model.turn events are the authoritative record of how far it got.
    expect(finished && "steps" in finished).toBe(false)
    expect(finished && "text" in finished).toBe(false)
  })

  it("rejects a loop that emits its own bookends — enforced by tsc, not by this assertion", () => {
    const bookendEmittingLoop: Loop = {
      name: "migrated-from-the-old-api",
      run: async (_req, ctx) => {
        // @ts-expect-error `LoopEventEmitter` excludes the bookends: they belong
        // to runWithEvents. If that exclusion were ever removed this line would
        // compile, and `@ts-expect-error` would then fail the build as unused —
        // which is what makes this a real control rather than a comment.
        ctx.events.emit({ type: "run.started", maxSteps: 1, maxDurationMs: 1, tools: [] })
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    expect(bookendEmittingLoop.name).toBe("migrated-from-the-old-api")
  })

  it("keeps one gapless sequence across the wrapper and the loop", async () => {
    const { sink, events } = recordRunEvents()
    await runWithEvents(nativeLoop, request(new ScriptedProvider()), {
      log: () => {},
      events: runEventEmitter(sink),
    })

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    expect(events[0]?.type).toBe("run.started")
    expect(events[events.length - 1]?.type).toBe("run.finished")
  })
})

describe("resolveLoopLimits", () => {
  it("resolves partial budgets from one place", () => {
    expect(resolveLoopLimits()).toEqual({ maxSteps: 12, maxDurationMs: 600_000 })
    expect(resolveLoopLimits({ maxSteps: 3 })).toEqual({ maxSteps: 3, maxDurationMs: 600_000 })
    expect(resolveLoopLimits({ maxDurationMs: 5 })).toEqual({ maxSteps: 12, maxDurationMs: 5 })
  })
})

describe("NativeEngine loop seam", () => {
  it("defaults to the native loop when none is injected", async () => {
    const engine = new NativeEngine()
    const result = await engine.run(spec({ provider: { preferred: "mock" } }), {
      log: () => {},
    })
    expect(typeof result.text).toBe("string")
  })

  it("drives the injected loop instead of the native one", async () => {
    const seen: LoopRequest[] = []
    const stub: Loop = {
      name: "stub",
      run: async (req) => {
        seen.push(req)
        return { text: "from the stub", steps: 0, outcome: "completed" }
      },
    }

    const result = await new NativeEngine({ loop: stub }).run(
      spec({ workflow: { name: "wf", prompt: "do it" } }),
      { log: () => {} },
    )

    expect(result.text).toBe("from the stub")
    // The loop is handed resolved materials, not options to interpret.
    expect(seen[0]?.limits).toEqual({ maxSteps: 12, maxDurationMs: 600_000 })
    expect(seen[0]?.system).toContain("wf")
  })

  it("hands the loop the run's own budget overrides, resolved", async () => {
    const seen: LoopRequest[] = []
    const stub: Loop = {
      name: "stub",
      run: async (req) => {
        seen.push(req)
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    await new NativeEngine({ loop: stub }).run(spec({ limits: { maxSteps: 3 } }), {
      log: () => {},
    })
    expect(seen[0]?.limits).toEqual({ maxSteps: 3, maxDurationMs: 600_000 })
  })

  it("forwards the event sink to the injected loop, not only to the native one", async () => {
    const seen: (string | undefined)[] = []
    const stub: Loop = {
      name: "stub",
      run: async (_req, ctx) => {
        // The loop cannot emit an unnumbered event even if it tries: it is
        // handed the emitter, never the raw sink.
        ctx.events.emit({ type: "model.turn", step: 0, text: "mid", toolCalls: [] })
        seen.push("emitter")
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    const { sink, events } = recordRunEvents()
    await new NativeEngine({ loop: stub }).run(spec(), { log: () => {}, emit: sink })

    expect(seen).toEqual(["emitter"])
    // Bookends from the wrapper, the middle from the loop — and one gapless
    // sequence across both, which is the property the emitter exists for.
    expect(events.map((e) => e.type)).toEqual(["run.started", "model.turn", "run.finished"])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it("still hands the loop a working emitter when the caller wants no events", async () => {
    let threw = false
    const stub: Loop = {
      name: "stub",
      run: async (_req, ctx) => {
        // A no-sink emitter is a functioning no-op, so a loop never has to
        // branch on whether anyone is listening.
        try {
          ctx.events.emit({ type: "model.turn", step: 0, text: "", toolCalls: [] })
        } catch {
          threw = true
        }
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    await new NativeEngine({ loop: stub }).run(spec(), { log: () => {} })
    expect(threw).toBe(false)
  })

  it("lets an application gate on requiresConfirmation — the flow the seam exists for", async () => {
    ran = []
    // A loop that refuses to run anything needing confirmation. Before this
    // seam, expressing that meant forking runAgent.
    const confirmingLoop: Loop = {
      name: "confirm-first",
      run: async (req) => {
        const blocked = req.tools.filter((t) => t.meta?.requiresConfirmation === true)
        if (blocked.length > 0) {
          return {
            text: `awaiting confirmation for: ${blocked.map((t) => t.spec.name).join(", ")}`,
            steps: 0,
            outcome: "completed",
          }
        }
        return nativeLoop.run(req, { log: () => {}, events: runEventEmitter() })
      },
    }

    const result = await new NativeEngine({
      loop: confirmingLoop,
      domainTools: () => [actTool],
    }).run(spec(), { log: () => {} })

    expect(result.text).toContain("awaiting confirmation for: act")
    // The point: the tool never executed, and no kernel code was forked.
    expect(ran).toEqual([])
  })
})
