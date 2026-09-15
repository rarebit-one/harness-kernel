import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../types.js"
import { AcpEngine, EVE_AGENT, type AcpDriver, type AcpOptions } from "./acp.js"
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
    expect(engine.supports(spec()).ok).toBe(true)
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
    expect(ctx.logs.some((l) => l.includes("tool: edit_file"))).toBe(true)
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
