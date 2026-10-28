import { describe, it, expect, afterEach } from "vitest"
import { selectEngine } from "./index.js"
import { NativeEngine } from "./native.js"
import { ClaudeCodeEngine } from "./claudeCode.js"
import type { RunSpec } from "./types.js"

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

describe("selectEngine", () => {
  it("defaults to the native engine", () => {
    expect(selectEngine().name).toBe("native")
    expect(selectEngine(null).name).toBe("native")
    expect(selectEngine("native").name).toBe("native")
  })

  it("falls back to native for an unknown engine name", () => {
    expect(selectEngine("nope").name).toBe("native")
  })

  it("resolves the claude-code engine by name", () => {
    expect(selectEngine("claude-code").name).toBe("claude-code")
  })

  it("resolves the codex engine by name when given a capability script", () => {
    expect(selectEngine("codex", { capabilityServerScript: "/opt/app/caps.js" }).name).toBe("codex")
  })

  it("refuses codex without a capability script rather than serving an empty surface", () => {
    expect(() => selectEngine("codex")).toThrow(/capabilityServerScript/)
  })

  it("resolves the eve engine by name when given a capability script", () => {
    expect(selectEngine("eve", { capabilityServerScript: "/opt/app/caps.js" }).name).toBe("eve")
  })

  it("refuses eve without a capability script", () => {
    expect(() => selectEngine("eve")).toThrow(/capabilityServerScript/)
  })

  it("resolves the opencode engine by name when given a capability script", () => {
    expect(selectEngine("opencode", { capabilityServerScript: "/opt/app/caps.js" }).name).toBe(
      "opencode",
    )
  })

  it("refuses opencode without a capability script", () => {
    expect(() => selectEngine("opencode")).toThrow(/capabilityServerScript/)
  })

  it("resolves the gemini engine by name when given a capability script", () => {
    expect(selectEngine("gemini", { capabilityServerScript: "/opt/app/caps.js" }).name).toBe(
      "gemini",
    )
  })

  it("refuses gemini without a capability script", () => {
    expect(() => selectEngine("gemini")).toThrow(/capabilityServerScript/)
  })
})

describe("NativeEngine.supports", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("supports a run with no spec (the primitives are the isolation boundary)", () => {
    expect(new NativeEngine().supports()).toEqual({ ok: true })
  })

  it("refuses a run whose provider has no credential, with the reason, before anything is prepared", () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    const refused = new NativeEngine().supports(spec({ provider: { preferred: "anthropic" } }))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toMatch(/ANTHROPIC_API_KEY/)
    expect(new NativeEngine().supports(spec({ provider: {} })).ok).toBe(false)
  })

  it("runs a keyless spec on the mock when allowMockFallback is set, end to end", async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    // `supports()` and `run()` must judge the same selection: a run the first
    // accepted because of the opt-in cannot then throw inside the second.
    const run = spec({ provider: { preferred: "anthropic", allowMockFallback: true } })
    const engine = new NativeEngine()
    expect(engine.supports(run)).toEqual({ ok: true })
    const result = await engine.run(run, { log: () => {} })
    expect(result.provider).toBe("mock")
    expect(result.outcome).toBe("completed")
  })

  it("accepts the mock by request or by explicit fallback opt-in", () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    expect(new NativeEngine().supports(spec({ provider: { preferred: "mock" } }))).toEqual({
      ok: true,
    })
    expect(new NativeEngine().supports(spec({ provider: { allowMockFallback: true } }))).toEqual({
      ok: true,
    })
  })
})

describe("ClaudeCodeEngine.supports", () => {
  const engine = new ClaudeCodeEngine()
  const original = process.env.RUNNER_ENABLE_CLAUDE_CODE
  afterEach(() => {
    if (original === undefined) delete process.env.RUNNER_ENABLE_CLAUDE_CODE
    else process.env.RUNNER_ENABLE_CLAUDE_CODE = original
  })

  it("refuses when not enabled", () => {
    delete process.env.RUNNER_ENABLE_CLAUDE_CODE
    const res = engine.supports(spec({ workflow: { runner: { profile: "ephemeral" } } }))
    expect(res.ok).toBe(false)
  })

  it("refuses when enabled but not on the ephemeral profile (no container isolation)", () => {
    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    const res = engine.supports(spec({ workflow: { runner: { profile: "hosted" } } }))
    expect(res.ok).toBe(false)
  })

  it("refuses an ephemeral-profile run the caller and host don't both isolate", () => {
    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    const res = engine.supports(spec({ workflow: { runner: { profile: "ephemeral" } } }))
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toMatch(/requires at least container isolation/)
  })

  it("supports when enabled, on the ephemeral profile and isolated", () => {
    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    process.env.RUNNER_ISOLATION = "container"
    try {
      const res = engine.supports(
        spec({ isolation: "container", workflow: { runner: { profile: "ephemeral" } } }),
      )
      expect(res).toEqual({ ok: true })
    } finally {
      delete process.env.RUNNER_ISOLATION
    }
  })
})
