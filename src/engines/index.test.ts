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

  it("resolves the codex engine by name", () => {
    expect(selectEngine("codex").name).toBe("codex")
  })
})

describe("NativeEngine.supports", () => {
  it("always supports a run (the primitives are the isolation boundary)", () => {
    expect(new NativeEngine().supports()).toEqual({ ok: true })
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

  it("supports when enabled and on the ephemeral profile", () => {
    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    const res = engine.supports(spec({ workflow: { runner: { profile: "ephemeral" } } }))
    expect(res).toEqual({ ok: true })
  })
})
