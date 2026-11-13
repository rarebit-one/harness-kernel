import { describe, expect, it } from "vitest"
import type { Tool } from "../tools/registry.js"
import type { ToolMetadata } from "../tools/metadata.js"
import { AcpEngine, EVE_AGENT } from "./acp.js"
import { ClaudeCodeEngine } from "./claudeCode.js"
import { CodexEngine } from "./codex.js"
import { refuseToolScoping, scopeRunTools } from "./toolScoping.js"
import type { RunSpec } from "./types.js"

const SCRIPT = "/opt/harness/capabilityStdio.js"

function tool(name: string, meta?: ToolMetadata): Tool {
  return {
    spec: { name, description: name, inputSchema: { type: "object" } },
    ...(meta ? { meta } : {}),
    execute: () => Promise.resolve("ok"),
  }
}

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "ws",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do it.", runner: { profile: "ephemeral" } },
    inputs: {},
    context: "",
    workdir: "/tmp",
    permissions: {},
    secrets: {},
    connectors: [],
    provider: {},
    isolation: "container",
    ...overrides,
  }
}

/** Run `fn` with `vars` set on process.env, restoring every one afterwards. */
function withEnv<T>(vars: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("scopeRunTools", () => {
  const surface = [
    tool("plain"),
    tool("book", { targetCapabilities: ["booking"] }),
    tool("nightly", { invocationModes: ["system_initiated"] }),
  ]
  const names = (tools: Tool[]): string[] => tools.map((t) => t.spec.name)

  it("leaves a spec that sets neither field unscoped", () => {
    expect(scopeRunTools(surface, {})).toBe(surface)
  })

  it("narrows by capability, failing closed on the mode the spec leaves absent", () => {
    expect(names(scopeRunTools(surface, { capability: "booking" }))).toEqual(["plain", "book"])
  })

  it("narrows by mode, failing closed on the capability the spec leaves absent", () => {
    expect(names(scopeRunTools(surface, { mode: "system_initiated" }))).toEqual([
      "plain",
      "nightly",
    ])
    expect(
      names(scopeRunTools(surface, { capability: "booking", mode: "system_initiated" })),
    ).toEqual(["plain", "book", "nightly"])
  })
})

describe("refuseToolScoping", () => {
  it("lets an unscoped run through and names the fields a scoped one sets", () => {
    expect(refuseToolScoping("codex", {})).toBeUndefined()
    expect(refuseToolScoping("codex", { capability: "booking", mode: "user_initiated" })).toEqual({
      ok: false,
      reason:
        "codex engine cannot scope its tools by metadata (the run sets capability and mode); " +
        "use the native engine or drop the field",
    })
  })

  it.each([
    ["claude-code", () => new ClaudeCodeEngine()],
    ["codex", () => new CodexEngine(undefined, SCRIPT)],
    ["eve", () => new AcpEngine(EVE_AGENT, SCRIPT)],
  ] as const)("%s refuses a scoped run in supports()", (name, make) => {
    withEnv(
      {
        RUNNER_ENABLE_CLAUDE_CODE: "1",
        RUNNER_ENABLE_CODEX: "1",
        RUNNER_ENABLE_EVE: "1",
        RUNNER_ISOLATION: "container",
      },
      () => {
        const engine = make()
        expect(engine.supports(spec())).toEqual({ ok: true })
        const refused = engine.supports(spec({ mode: "system_initiated" }))
        expect(!refused.ok && refused.reason).toBe(
          `${name} engine cannot scope its tools by metadata (the run sets mode); ` +
            "use the native engine or drop the field",
        )
      },
    )
  })
})
