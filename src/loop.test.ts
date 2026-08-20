import { describe, it, expect } from "vitest"
import { runAgent, resolveLoopLimits } from "./agent.js"
import { NativeEngine } from "./engines/native.js"
import type { RunSpec } from "./engines/types.js"
import { recordRunEvents, runEventEmitter } from "./events.js"
import { nativeLoop, type Loop, type LoopRequest } from "./loop.js"
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
    const result = await nativeLoop.run(request(new ScriptedProvider()), { log: () => {} })

    expect(result).toEqual({ text: "done", steps: 2, outcome: "completed" })
    expect(nativeLoop.name).toBe("native")
  })

  it("agrees with its own run.finished event — one run, not two sources of truth", async () => {
    const { sink, events } = recordRunEvents()
    const result = await nativeLoop.run(
      request(new LoopingProvider(), { limits: resolveLoopLimits({ maxSteps: 2 }) }),
      {
        log: () => {},
        emit: sink,
      },
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
    const viaLoop = await nativeLoop.run(request(new ScriptedProvider()), { log: () => {} })
    const viaRunAgent = await runAgent({
      provider: new ScriptedProvider(),
      system: "s",
      userPrompt: "go",
      tools: [actTool],
    })

    expect(viaRunAgent).toBe(viaLoop.text)
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
    const result = await engine.run(spec({ provider: { preferred: "mock" } }), { log: () => {} })
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

    await new NativeEngine({ loop: stub }).run(spec({ limits: { maxSteps: 3 } }), { log: () => {} })
    expect(seen[0]?.limits).toEqual({ maxSteps: 3, maxDurationMs: 600_000 })
  })

  it("forwards the event sink to the injected loop, not only to the native one", async () => {
    const seen: (string | undefined)[] = []
    const stub: Loop = {
      name: "stub",
      run: async (_req, ctx) => {
        // A custom loop owns its own stream; the engine's job is only to hand
        // the sink over. Note it builds its own emitter rather than calling the
        // sink directly — `seq`/`at` are the emitter's to stamp, which is what
        // keeps one run's sequence gapless no matter who is looping.
        runEventEmitter(ctx.emit, ctx.log).emit({
          type: "run.started",
          maxSteps: 1,
          maxDurationMs: 1,
          tools: [],
        })
        seen.push(ctx.emit ? "sink" : undefined)
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    const { sink, events } = recordRunEvents()
    await new NativeEngine({ loop: stub }).run(spec(), { log: () => {}, emit: sink })

    expect(seen).toEqual(["sink"])
    expect(events.map((e) => e.type)).toEqual(["run.started"])
  })

  it("omits emit entirely when the caller supplied none", async () => {
    let had = true
    const stub: Loop = {
      name: "stub",
      run: async (_req, ctx) => {
        had = ctx.emit !== undefined
        return { text: "", steps: 0, outcome: "completed" }
      },
    }

    await new NativeEngine({ loop: stub }).run(spec(), { log: () => {} })
    expect(had).toBe(false)
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
        return nativeLoop.run(req, { log: () => {} })
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
