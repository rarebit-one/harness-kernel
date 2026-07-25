import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../types.js"
import { CodexEngine, type CodexMessage, type CodexOptions } from "./codex.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"
import type { EngineContext, RunSpec } from "./types.js"

function spec(overrides: Partial<RunSpec> = {}, workdir = "/sandbox/x"): RunSpec {
  return {
    runId: "r",
    workspaceId: "ws-self",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing.", runner: { profile: "ephemeral" } },
    inputs: { foo: 1 },
    context: "",
    workdir,
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

const SCRIPT = "/opt/harness/capabilityStdio.js"

describe("CodexEngine.supports", () => {
  const saved = process.env.RUNNER_ENABLE_CODEX
  afterEach(() => {
    if (saved === undefined) delete process.env.RUNNER_ENABLE_CODEX
    else process.env.RUNNER_ENABLE_CODEX = saved
  })

  it("gates on the enable flag and the ephemeral profile", () => {
    const engine = new CodexEngine(async function* () {}, SCRIPT)
    delete process.env.RUNNER_ENABLE_CODEX
    expect(engine.supports(spec()).ok).toBe(false)

    process.env.RUNNER_ENABLE_CODEX = "1"
    expect(engine.supports(spec({ workflow: { runner: { profile: "hosted" } } })).ok).toBe(false)
    expect(engine.supports(spec()).ok).toBe(true)
  })
})

describe("CodexEngine.run", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "codex-wd-"))
  })
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })

  it("maps the spec to driver options and returns the result text", async () => {
    let captured: CodexOptions | undefined
    async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
      captured = opts
      yield { kind: "assistant", text: "working" }
      yield { kind: "result", text: "## Done", isError: false }
    }
    const ctx = recordingCtx()
    const result = await new CodexEngine(driver, SCRIPT).run(
      spec(
        {
          provider: { model: "gpt-x", credentials: { openai: "sk-org" } },
          limits: { maxDurationMs: 9000 },
        },
        workdir,
      ),
      ctx,
    )
    expect(result.text).toBe("## Done")
    expect(captured?.cwd).toBe(workdir)
    expect(captured?.model).toBe("gpt-x")
    expect(captured?.apiKey).toBe("sk-org")
    expect(captured?.maxDurationMs).toBe(9000)
    expect(captured?.prompt).toContain("Do the thing.")
    expect(captured?.codexHome).toBeTruthy()
    // CODEX_HOME lives OUTSIDE the sandbox — it must never sit inside the change set.
    expect(captured?.codexHome.startsWith(workdir)).toBe(false)
    expect(ctx.logs.some((l) => l.includes("working"))).toBe(true)
  })

  it("writes a codex config.toml with the capability stdio server + connectors, then deletes it", async () => {
    let configDuringRun = ""
    let codexHome = ""
    async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
      // Observe the config.toml the engine wrote into CODEX_HOME while in flight.
      codexHome = opts.codexHome
      configDuringRun = await readFile(path.join(opts.codexHome, "config.toml"), "utf8")
      yield { kind: "result", text: "ok", isError: false }
    }
    const connectors: ConnectorConfig[] = [
      { name: "slack", kind: "mcp", transport: "streamable_http", endpoint: "https://s/" },
    ]
    await new CodexEngine(driver, SCRIPT).run(spec({ connectors }, workdir), recordingCtx())

    // Real codex format: `[mcp_servers.<name>]` sections in TOML — not `.mcp.json`.
    expect(configDuringRun).toContain('[mcp_servers."slack"]')
    expect(configDuringRun).toContain('url = "https://s/"')
    expect(configDuringRun).toContain(`[mcp_servers.${JSON.stringify(CAPABILITY_SERVER_NAME)}]`)
    expect(configDuringRun).toContain(`args = [${JSON.stringify(SCRIPT)}]`)
    expect(configDuringRun).toContain('"HARNESS_WORKSPACE_ID" = "ws-self"')
    expect(configDuringRun).toContain(`"HARNESS_WORKDIR" = ${JSON.stringify(workdir)}`)
    // No stray .mcp.json in the sandbox, and the token-bearing CODEX_HOME is gone.
    await expect(stat(path.join(workdir, ".mcp.json"))).rejects.toThrow()
    await expect(stat(codexHome)).rejects.toThrow()
  })

  it("folds the capability server's emissions into the result (emit parity)", async () => {
    // Simulate codex + the capability server: read the emissions path out of the
    // codex config.toml the engine wrote, and persist an emission there.
    async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
      const config = await readFile(path.join(opts.codexHome, "config.toml"), "utf8")
      const emissionsFile = /"HARNESS_EMISSIONS_FILE" = "([^"]+)"/.exec(config)?.[1]
      if (!emissionsFile) throw new Error("expected an emissions file in the capability server env")
      const { writeFile } = await import("node:fs/promises")
      await writeFile(
        emissionsFile,
        JSON.stringify({ issues: [{ title: "found it" }], knowledge: [{ content: "note" }] }),
      )
      yield { kind: "result", text: "done", isError: false }
    }
    const result = await new CodexEngine(driver, SCRIPT).run(spec({}, workdir), recordingCtx())
    expect(result.issues).toEqual([{ title: "found it" }])
    expect(result.knowledge).toEqual([{ content: "note" }])
  })

  it("returns a fallback when the harness produces no output", async () => {
    async function* driver(): AsyncIterable<CodexMessage> {
      yield { kind: "result", text: "", isError: true }
    }
    const ctx = recordingCtx()
    const result = await new CodexEngine(driver, SCRIPT).run(spec({}, workdir), ctx)
    expect(result.text).toBe("(no output)")
    expect(ctx.logs.some((l) => l.includes("error"))).toBe(true)
  })
})
