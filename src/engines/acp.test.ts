import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../types.js"
import {
  AcpEngine,
  EVE_AGENT,
  GEMINI_AGENT,
  OPENCODE_AGENT,
  type AcpDriver,
  type AcpOptions,
} from "./acp.js"
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

/** A fake driver that captures options and drives the client callbacks. */
function fakeDriver(
  script: (opts: AcpOptions, events: Parameters<AcpDriver>[1]) => Promise<{ stopReason: string }>,
): AcpDriver & { captured?: AcpOptions } {
  const drive = (async (opts, events) => {
    ;(drive as { captured?: AcpOptions }).captured = opts
    return script(opts, events)
  }) as AcpDriver & { captured?: AcpOptions }
  return drive
}

describe("AcpEngine.supports", () => {
  const saved = process.env.RUNNER_ENABLE_EVE
  afterEach(() => {
    if (saved === undefined) delete process.env.RUNNER_ENABLE_EVE
    else process.env.RUNNER_ENABLE_EVE = saved
  })

  it("gates on the agent's enable flag and the ephemeral profile", () => {
    const engine = new AcpEngine(
      EVE_AGENT,
      SCRIPT,
      fakeDriver(async () => ({ stopReason: "end_turn" })),
    )
    delete process.env.RUNNER_ENABLE_EVE
    expect(engine.supports(spec()).ok).toBe(false)

    process.env.RUNNER_ENABLE_EVE = "1"
    expect(engine.supports(spec({ workflow: { runner: { profile: "hosted" } } })).ok).toBe(false)
    expect(engine.supports(spec()).ok).toBe(false)
    process.env.RUNNER_ISOLATION = "vm"
    expect(engine.supports(spec({ isolation: "vm" })).ok).toBe(true)
    delete process.env.RUNNER_ISOLATION
  })
})

describe("AcpEngine.run", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "acp-wd-"))
  })
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })

  it("maps the spec to driver options and accumulates message chunks into the result", async () => {
    const drive = fakeDriver(async (_opts, events) => {
      events.onAssistantChunk("Hello ")
      events.onAssistantChunk("world")
      events.onLog("tool: edit_file")
      return { stopReason: "end_turn" }
    })
    const ctx = recordingCtx()
    const result = await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(
      spec(
        {
          provider: { model: "irrelevant-to-eve", credentials: { anthropic: "sk-org" } },
          limits: { maxDurationMs: 9000 },
        },
        workdir,
      ),
      ctx,
    )

    expect(result.text).toBe("Hello world")
    expect(drive.captured?.command).toBe("eve")
    expect(drive.captured?.args).toEqual(["acp"])
    expect(drive.captured?.cwd).toBe(workdir)
    expect(drive.captured?.maxDurationMs).toBe(9000)
    expect(drive.captured?.prompt).toContain("Do the thing.")
    // The BYO provider key is passed through to the eve process env.
    expect(drive.captured?.env.ANTHROPIC_API_KEY).toBe("sk-org")
    // The capability env also rides on the process env for the stdio server.
    expect(drive.captured?.env.HARNESS_WORKDIR).toBe(workdir)
    // The agent's inherit prefixes reach the driver, which spawns with an allowlist.
    expect(drive.captured?.inheritEnvPrefixes).toEqual(EVE_AGENT.inheritEnvPrefixes)
    expect(ctx.logs.some((l) => l.includes("tool: edit_file"))).toBe(true)
  })

  it("puts the run's pre-assembled context in the prompt", async () => {
    const drive = fakeDriver(async () => ({ stopReason: "end_turn" }))
    await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(
      spec({ context: "### notes.md\nThe deadline is Friday." }, workdir),
      recordingCtx(),
    )
    expect(drive.captured?.prompt).toContain(
      "## Workspace context\n### notes.md\nThe deadline is Friday.",
    )
  })

  it("hands the capability server + connectors to the agent as ACP mcpServers", async () => {
    const drive = fakeDriver(async () => ({ stopReason: "end_turn" }))
    const connectors: ConnectorConfig[] = [
      { name: "slack", kind: "mcp", transport: "streamable_http", endpoint: "https://s/" },
    ]
    await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(spec({ connectors }, workdir), recordingCtx())

    const servers = drive.captured?.mcpServers ?? []
    const slack = servers.find((s) => s.name === "slack")
    expect(slack).toMatchObject({ type: "http", url: "https://s/" })

    const capability = servers.find((s) => s.name === CAPABILITY_SERVER_NAME)
    // The capability server is a stdio server: the ACP shape has command/args/env,
    // no `type` field.
    expect(capability).toBeDefined()
    expect(capability && "command" in capability ? capability.command : undefined).toBe(
      process.execPath,
    )
    expect(capability && "args" in capability ? capability.args : undefined).toContain(SCRIPT)
    const env = capability && "env" in capability ? capability.env : []
    expect(env).toContainEqual({ name: "HARNESS_WORKSPACE_ID", value: "ws-self" })
  })

  it("folds the capability server's emissions into the result (emit parity)", async () => {
    const drive = fakeDriver(async (opts) => {
      // Simulate the capability server writing to the emissions file the engine
      // provisioned (its path arrives on the process env, exactly as the server sees it).
      const emissionsFile = opts.env.HARNESS_EMISSIONS_FILE
      if (!emissionsFile) throw new Error("expected an emissions file on the process env")
      await writeFile(
        emissionsFile,
        JSON.stringify({ issues: [{ title: "found it" }], knowledge: [{ content: "note" }] }),
      )
      return { stopReason: "end_turn" }
    })
    const result = await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(
      spec({}, workdir),
      recordingCtx(),
    )
    // Passed through verbatim — the kernel never looked inside it.
    expect(result.emissions).toEqual({
      issues: [{ title: "found it" }],
      knowledge: [{ content: "note" }],
    })
  })

  it("returns a fallback when the agent produced no prose", async () => {
    const drive = fakeDriver(async () => ({ stopReason: "end_turn" }))
    const result = await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(
      spec({}, workdir),
      recordingCtx(),
    )
    expect(result.text).toBe("(no output)")
  })

  it("logs a non-end_turn stop reason", async () => {
    const drive = fakeDriver(async (_opts, events) => {
      events.onAssistantChunk("partial")
      return { stopReason: "cancelled" }
    })
    const ctx = recordingCtx()
    await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(spec({}, workdir), ctx)
    expect(ctx.logs.some((l) => l.includes("stopped (cancelled)"))).toBe(true)
  })
})

describe("OPENCODE_AGENT spec", () => {
  it("launches with 'opencode acp' and maps BYO credentials onto provider env vars", () => {
    expect(OPENCODE_AGENT.name).toBe("opencode")
    expect(OPENCODE_AGENT.command).toBe("opencode")
    expect(OPENCODE_AGENT.args(spec())).toEqual(["acp"])

    const s = spec({
      provider: { credentials: { anthropic: "sk-ant", openai: "sk-oai", openrouter: "sk-or" } },
    })
    const env = OPENCODE_AGENT.env(s)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant")
    expect(env.OPENAI_API_KEY).toBe("sk-oai")
    expect(env.OPENROUTER_API_KEY).toBe("sk-or")
  })

  it("passes no keys when credentials are absent", () => {
    const env = OPENCODE_AGENT.env(spec())
    expect(Object.keys(env).filter((k) => k.endsWith("_API_KEY"))).toHaveLength(0)
  })

  it("supports gateway runs (all three providers have routes)", () => {
    expect(OPENCODE_AGENT.gatewaySupported).toBeUndefined()
  })

  it("declares no host key envs (reads only from spec.provider.credentials)", () => {
    expect(OPENCODE_AGENT.hostKeyEnvs).toBeUndefined()
  })

  it("includes OPENCODE_ in its inherit prefixes alongside the provider prefixes", () => {
    expect(OPENCODE_AGENT.inheritEnvPrefixes).toContain("OPENCODE_")
    expect(OPENCODE_AGENT.inheritEnvPrefixes).toContain("ANTHROPIC_")
  })
})

describe("GEMINI_AGENT spec", () => {
  const savedKey = process.env.GEMINI_API_KEY
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = savedKey
  })

  it("launches with 'gemini --acp' (flag, not subcommand)", () => {
    expect(GEMINI_AGENT.name).toBe("gemini")
    expect(GEMINI_AGENT.command).toBe("gemini")
    expect(GEMINI_AGENT.args(spec())).toEqual(["--acp"])
  })

  it("reads GEMINI_API_KEY from the host env (no BYO credentials slot)", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"
    const env = GEMINI_AGENT.env(spec())
    expect(env.GEMINI_API_KEY).toBe("test-gemini-key")
  })

  it("passes no key when GEMINI_API_KEY is absent from the host env", () => {
    delete process.env.GEMINI_API_KEY
    const env = GEMINI_AGENT.env(spec())
    expect(env.GEMINI_API_KEY).toBeUndefined()
  })

  it("refuses gateway runs because the gateway has no route for Gemini's provider", () => {
    const savedEnable = process.env.RUNNER_ENABLE_GEMINI
    process.env.RUNNER_ENABLE_GEMINI = "1"
    process.env.RUNNER_ISOLATION = "vm"
    try {
      const engine = new AcpEngine(
        GEMINI_AGENT,
        SCRIPT,
        fakeDriver(async () => ({ stopReason: "end_turn" })),
      )
      const result = engine.supports(
        spec({
          isolation: "vm",
          gateway: { baseUrl: "https://gw.example.com", runToken: "tok-abc" },
        }),
      )
      expect(result.ok).toBe(false)
      expect((result as { ok: false; reason: string }).reason).toMatch(/no gateway route/)
    } finally {
      if (savedEnable === undefined) delete process.env.RUNNER_ENABLE_GEMINI
      else process.env.RUNNER_ENABLE_GEMINI = savedEnable
      delete process.env.RUNNER_ISOLATION
    }
  })

  it("passes no host key when the run turns host credential fallback off", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"
    const env = GEMINI_AGENT.env(spec({ provider: { envFallback: false } }))
    expect(env.GEMINI_API_KEY).toBeUndefined()
  })

  it("refuses a run that turns host credential fallback off, since the host is its only key source", () => {
    const savedEnable = process.env.RUNNER_ENABLE_GEMINI
    process.env.RUNNER_ENABLE_GEMINI = "1"
    process.env.RUNNER_ISOLATION = "vm"
    try {
      const engine = new AcpEngine(
        GEMINI_AGENT,
        SCRIPT,
        fakeDriver(async () => ({ stopReason: "end_turn" })),
      )
      const result = engine.supports(spec({ isolation: "vm", provider: { envFallback: false } }))
      expect(result.ok).toBe(false)
      expect((result as { ok: false; reason: string }).reason).toMatch(
        /disables host credential fallback/,
      )
    } finally {
      if (savedEnable === undefined) delete process.env.RUNNER_ENABLE_GEMINI
      else process.env.RUNNER_ENABLE_GEMINI = savedEnable
      delete process.env.RUNNER_ISOLATION
    }
  })

  it("declares GEMINI_API_KEY as a host key env for vm credential checks", () => {
    expect(GEMINI_AGENT.hostKeyEnvs).toContain("GEMINI_API_KEY")
  })

  it("includes GEMINI_ and GOOGLE_ inherit prefixes for CLI config vars", () => {
    expect(GEMINI_AGENT.inheritEnvPrefixes).toContain("GEMINI_")
    expect(GEMINI_AGENT.inheritEnvPrefixes).toContain("GOOGLE_")
  })
})
