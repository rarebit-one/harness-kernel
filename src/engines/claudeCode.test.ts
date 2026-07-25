import { describe, it, expect, afterEach } from "vitest"
import { ClaudeCodeEngine, type ClaudeCodeMessage, type ClaudeCodeOptions } from "./claudeCode.js"
import type { EngineContext, RunSpec } from "./types.js"

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing." },
    inputs: { foo: 1 },
    context: "",
    workdir: "/sandbox/x",
    permissions: {},
    secrets: {},
    connectors: [],
    provider: {},
    ...overrides,
  }
}

function recordingCtx(): EngineContext & { logs: string[] } {
  const logs: string[] = []
  return { log: (line: string) => logs.push(line), logs }
}

describe("ClaudeCodeEngine.run", () => {
  const savedFlag = process.env.RUNNER_ENABLE_CLAUDE_CODE
  const savedKey = process.env.ANTHROPIC_API_KEY
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.RUNNER_ENABLE_CLAUDE_CODE
    else process.env.RUNNER_ENABLE_CLAUDE_CODE = savedFlag
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  it("maps the spec to driver options, streams assistant logs, and returns the result text", async () => {
    let captured: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      captured = opts
      yield { kind: "assistant", text: "working on it" }
      yield { kind: "result", text: "## Done", isError: false }
    }

    const ctx = recordingCtx()
    const result = await new ClaudeCodeEngine(driver).run(
      spec({
        provider: { model: "claude-sonnet-4-6", credentials: { anthropic: "sk-org" } },
        permissions: { tools: ["Read", "Edit", "Bash"] },
        limits: { maxDurationMs: 5000 },
      }),
      ctx,
    )

    expect(result.text).toBe("## Done")
    expect(result.knowledge).toEqual([])
    // The engine hands the driver its runner-hosted capability surface.
    expect(captured?.mcpTools?.map((t) => t.name).sort()).toEqual(
      ["open_issue", "promote_knowledge", "write_file"].sort(),
    )
    expect(captured?.cwd).toBe("/sandbox/x")
    expect(captured?.model).toBe("claude-sonnet-4-6")
    expect(captured?.apiKey).toBe("sk-org")
    expect(captured?.allowedTools).toEqual(["Read", "Edit", "Bash"])
    expect(captured?.maxDurationMs).toBe(5000)
    expect(captured?.prompt).toContain("Do the thing.")
    expect(ctx.logs.some((l) => l.includes("working on it"))).toBe(true)
  })

  it("passes the run's connectors to the driver (mounted as mcpServers there)", async () => {
    let captured: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      captured = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    const connectors = [
      {
        name: "slack",
        kind: "mcp" as const,
        transport: "streamable_http" as const,
        endpoint: "https://s/",
      },
    ]
    await new ClaudeCodeEngine(driver).run(spec({ connectors }), recordingCtx())
    expect(captured?.connectors).toEqual(connectors)
  })

  it("omits connectors from the options when the run has none", async () => {
    let captured: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      captured = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    await new ClaudeCodeEngine(driver).run(spec({ connectors: [] }), recordingCtx())
    expect(captured?.connectors).toBeUndefined()
  })

  it("defaults the model to claude-opus-4-8 and falls back to the runner env key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env"
    let captured: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      captured = opts
      yield { kind: "result", text: "ok", isError: false }
    }

    await new ClaudeCodeEngine(driver).run(spec({ provider: {} }), recordingCtx())

    expect(captured?.model).toBe("claude-opus-4-8")
    expect(captured?.apiKey).toBe("sk-env")
    expect(captured?.allowedTools).toBeUndefined()
  })

  it("emits issues + knowledge when the agent uses the capability surface (parity with native)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env"
    // A driver that drives the run by invoking the capability tools it was handed,
    // exactly as the real Claude Code harness would via the mounted MCP server.
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      const byName = (n: string) => opts.mcpTools?.find((t) => t.name === n)
      await byName("open_issue")?.handler({ title: "Look at this", dedupe_key: "k" })
      await byName("promote_knowledge")?.handler({ content: "learned X" })
      yield { kind: "result", text: "## Done", isError: false }
    }

    const result = await new ClaudeCodeEngine(driver).run(spec(), recordingCtx())

    expect(result.issues).toEqual([{ title: "Look at this", dedupe_key: "k" }])
    expect(result.knowledge).toEqual([{ content: "learned X" }])
  })

  it("returns a fallback and notes an error when the harness ends in error", async () => {
    async function* driver(_opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      yield { kind: "result", text: "", isError: true }
    }

    const ctx = recordingCtx()
    const result = await new ClaudeCodeEngine(driver).run(spec(), ctx)

    expect(result.text).toBe("(no output)")
    expect(ctx.logs.some((l) => l.includes("error"))).toBe(true)
  })

  it("still gates via supports() (disabled / wrong profile / ok)", () => {
    const engine = new ClaudeCodeEngine(async function* () {})
    delete process.env.RUNNER_ENABLE_CLAUDE_CODE
    expect(engine.supports(spec({ workflow: { runner: { profile: "ephemeral" } } })).ok).toBe(false)

    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    expect(engine.supports(spec({ workflow: { runner: { profile: "hosted" } } })).ok).toBe(false)
    expect(engine.supports(spec({ workflow: { runner: { profile: "ephemeral" } } }))).toEqual({
      ok: true,
    })
  })
})
