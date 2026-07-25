import { describe, it, expect, vi, afterEach } from "vitest"
import { NativeEngine } from "../engines/native.js"
import type { RunSpec } from "../engines/types.js"
import { assembleContext, renderContext, type ContextProvider } from "./types.js"

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: { prompt: "Go." },
    inputs: {},
    context: "",
    workdir: "/tmp/ctx",
    permissions: {},
    secrets: {},
    connectors: [],
    provider: {},
    ...overrides,
  }
}

/** Keep the engine on the offline mock provider regardless of the host's env. */
function forceOfflineProvider(): void {
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  vi.stubEnv("OPENAI_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
}

const provider = (name: string, text: string, priority?: number): ContextProvider => ({
  name,
  assemble: () => Promise.resolve([{ source: name, text, ...(priority ? { priority } : {}) }]),
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("assembleContext", () => {
  it("gathers fragments from every provider", async () => {
    const fragments = await assembleContext([provider("a", "alpha"), provider("b", "beta")], spec())
    expect(fragments.map((f) => f.text)).toEqual(["alpha", "beta"])
  })

  it("orders by descending priority, keeping registration order for ties", async () => {
    const fragments = await assembleContext(
      [provider("low", "l"), provider("high", "h", 10), provider("mid", "m", 5)],
      spec(),
    )
    expect(fragments.map((f) => f.source)).toEqual(["high", "mid", "low"])
  })

  it("runs providers concurrently rather than in series", async () => {
    const slow = (name: string, ms: number): ContextProvider => ({
      name,
      assemble: () =>
        new Promise((resolve) => setTimeout(() => resolve([{ source: name, text: name }]), ms)),
    })

    const started = Date.now()
    await assembleContext([slow("a", 40), slow("b", 40), slow("c", 40)], spec())
    // Serial would be ~120ms; concurrent is ~40ms. The margin is wide enough to
    // survive a loaded CI box without being flaky.
    expect(Date.now() - started).toBeLessThan(110)
  })

  it("skips a failing provider and keeps the rest, logging why", async () => {
    const log = vi.fn()
    const broken: ContextProvider = {
      name: "broken",
      assemble: () => Promise.reject(new Error("feed offline")),
    }

    const fragments = await assembleContext([broken, provider("ok", "kept")], spec(), log)

    expect(fragments.map((f) => f.text)).toEqual(["kept"])
    expect(log).toHaveBeenCalledWith("context provider broken failed: feed offline")
  })

  it("hands providers the run's own spec", async () => {
    const seen: string[] = []
    const nosy: ContextProvider = {
      name: "nosy",
      assemble: (s) => {
        seen.push(`${s.workspaceId}/${s.workflowPath}`)
        return Promise.resolve([])
      },
    }

    await assembleContext([nosy], spec({ workspaceId: "ws-7", workflowPath: "beats/x.yml" }))
    expect(seen).toEqual(["ws-7/beats/x.yml"])
  })
})

describe("renderContext", () => {
  it("renders each fragment as a titled section", () => {
    expect(renderContext([{ source: "feed", text: "a cat" }])).toBe("### feed\na cat")
  })

  it("renders nothing for no fragments", () => {
    expect(renderContext([])).toBe("")
  })
})

describe("NativeEngine context providers", () => {
  // (c) A fake ContextProvider injects fragments that an engine actually
  //     consumes — visible in what reached the model.
  it("injects provider fragments into the prompt the model receives", async () => {
    forceOfflineProvider()
    const engine = new NativeEngine({
      contextProviders: [provider("live-feed", "the user is looking at a red mug")],
    })

    const result = await engine.run(spec(), { log: () => {} })

    // The mock provider echoes the prompt it was handed, so seeing the fragment
    // here proves it travelled all the way into the model call.
    expect(result.text).toContain("### live-feed")
    expect(result.text).toContain("the user is looking at a red mug")
  })

  it("appends fragments after the spec's own context rather than replacing it", async () => {
    forceOfflineProvider()
    const engine = new NativeEngine({ contextProviders: [provider("extra", "FRAGMENT-TEXT")] })

    const result = await engine.run(spec({ context: "SPEC-CONTEXT" }), { log: () => {} })

    expect(result.text).toContain("SPEC-CONTEXT")
    expect(result.text).toContain("FRAGMENT-TEXT")
    expect(result.text.indexOf("SPEC-CONTEXT")).toBeLessThan(result.text.indexOf("FRAGMENT-TEXT"))
  })

  it("leaves the prompt exactly as before when no providers are configured", async () => {
    forceOfflineProvider()
    const withNone = await new NativeEngine().run(spec({ context: "SPEC-CONTEXT" }), {
      log: () => {},
    })
    const withEmpty = await new NativeEngine({ contextProviders: [] }).run(
      spec({ context: "SPEC-CONTEXT" }),
      { log: () => {} },
    )

    expect(withEmpty.text).toBe(withNone.text)
    expect(withNone.text).not.toContain("###")
  })
})
