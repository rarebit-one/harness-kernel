import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { recordRunEvents } from "./events.js"
import { nativeLoop, type Loop } from "./loop.js"
import { asChatModel } from "./models/chat.js"
import { PRIVATE_REDACTION, PrivateRunError, privateRunChannels } from "./private.js"
import type { ConverseResult, Provider } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"
import type { ContextProvider } from "./context/types.js"
import { NativeEngine } from "./engines/native.js"
import { ClaudeCodeEngine } from "./engines/claudeCode.js"
import { CodexEngine } from "./engines/codex.js"
import { AcpEngine, EVE_AGENT } from "./engines/acp.js"
import { selectEngine } from "./engines/index.js"
import type { RunSpec } from "./engines/types.js"

/** Every piece of the run's material carries this, so a leak is a substring. */
const CANARY = "CANARY-7f3a"

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r1",
    workspaceId: "w1",
    workflowPath: "wf.yml",
    workflow: { name: "wf", prompt: "answer" },
    inputs: {},
    context: "",
    workdir: mkdtempSync(path.join(tmpdir(), "harness-private-")),
    permissions: {},
    secrets: {},
    connectors: [],
    provider: { preferred: "mock" },
    ...overrides,
  }
}

/** Turn 1: prose plus a real tool call, a made-up tool and a failing tool. Turn 2: the answer. */
class ScriptedProvider implements Provider {
  readonly name = "scripted"
  private turn = 0
  async complete(): Promise<string> {
    return ""
  }
  async converse(): Promise<ConverseResult> {
    this.turn += 1
    if (this.turn === 1) {
      return {
        text: `thinking about ${CANARY}-turn`,
        toolCalls: [
          // Call ids are provider output too, so they carry the canary.
          { id: `${CANARY}-id1`, name: "read_item", input: { ref: `${CANARY}-arg` } },
          { id: `${CANARY}-id2`, name: `${CANARY}-invented`, input: {} },
          { id: `${CANARY}-id3`, name: "broken_item", input: { ref: `${CANARY}-arg2` } },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    return {
      text: `the answer is ${CANARY}-final`,
      toolCalls: [],
      // A provider-supplied label: free text, so it must not survive either.
      usage: { units: 3, unit: `${CANARY}-unit` } as unknown as ConverseResult["usage"],
    }
  }
}

const tools: Tool[] = [
  {
    spec: { name: "read_item", description: "read", inputSchema: { type: "object" } },
    execute: async () => `${CANARY}-result`,
  },
  {
    spec: { name: "broken_item", description: "fails", inputSchema: { type: "object" } },
    execute: async () => {
      throw new Error(`could not open ${CANARY}-error`)
    },
  },
]

/** Drives the real native loop, but over the scripted model. */
const scriptedLoop: Loop = {
  name: "scripted",
  run: (req, ctx) => nativeLoop.run({ ...req, model: asChatModel(new ScriptedProvider()) }, ctx),
}

const failingContext: ContextProvider = {
  name: "failing",
  assemble: async () => {
    throw new Error(`context source said ${CANARY}-ctx`)
  },
}

function engine(): NativeEngine {
  return new NativeEngine({
    loop: scriptedLoop,
    domainTools: () => tools,
    contextProviders: [failingContext],
  })
}

/** A private run's prerequisites: the local provider, configured. The scripted
 *  loop swaps the model, so nothing is ever sent to this address. */
const LOCAL = { preferred: "local" } as const
const saved = { ...process.env }
function useLocalProvider(): void {
  beforeEach(() => {
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
  })
  afterEach(() => {
    process.env = { ...saved }
  })
}

describe("NativeEngine private runs", () => {
  useLocalProvider()

  it("leaks the material through log and events when NOT private (the control)", async () => {
    const lines: string[] = []
    const { sink, events } = recordRunEvents()
    await engine().run(spec(), { log: (l) => lines.push(l), emit: sink })

    expect(lines.join("\n")).toContain(CANARY)
    expect(JSON.stringify(events)).toContain(CANARY)
    expect(events.some((e) => e.redacted)).toBe(false)
  })

  it("sends phase codes only: no tool arguments, results, model text or errors", async () => {
    const lines: string[] = []
    const { sink, events } = recordRunEvents()
    const result = await engine().run(spec({ private: true, provider: LOCAL }), {
      log: (l) => lines.push(l),
      emit: sink,
    })

    // The canary: nothing the run handled reaches either channel.
    expect(lines.join("\n")).not.toContain(CANARY)
    expect(JSON.stringify(events)).not.toContain(CANARY)

    // The stream keeps its shape: same sequence, gapless, every event marked.
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "tool.called",
      "tool.failed",
      "model.turn",
      "run.finished",
    ])
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    expect(events.every((e) => e.redacted === true)).toBe(true)

    // Call ids are replaced by first-seen surrogates that still correlate.
    const turnIds = events[1]?.type === "model.turn" ? events[1].toolCalls.map((c) => c.id) : []
    expect(turnIds).toEqual(["call-1", "call-2", "call-3"])
    const toolIds = events.flatMap((e) =>
      e.type === "tool.called" || e.type === "tool.succeeded" || e.type === "tool.failed"
        ? [e.callId]
        : [],
    )
    expect(toolIds).toEqual(["call-1", "call-1", "call-2", "call-3", "call-3"])
    const lastTurn = events[7]
    expect(lastTurn?.type === "model.turn" && lastTurn.usage).toEqual({ units: 3 })

    const turn = events[1]
    expect(turn?.type === "model.turn" && turn.text).toBe("")
    // A name the run registered survives; one the model invented is model output.
    expect(turn?.type === "model.turn" && turn.toolCalls.map((c) => c.name)).toEqual([
      "read_item",
      "(unregistered)",
      "broken_item",
    ])
    expect(turn?.type === "model.turn" && turn.usage).toBeTruthy()
    const called = events[2]
    expect(called?.type === "tool.called" && called.input).toEqual({})
    const failed = events[6]
    expect(failed?.type === "tool.failed" && failed.error).toBe(PRIVATE_REDACTION)
    const finished = events.at(-1)
    expect(finished?.type === "run.finished" && finished.outcome).toBe("completed")
    expect(finished && "text" in finished).toBe(false)

    // Log lines are the fixed phase vocabulary, one per event, and nothing else.
    expect(lines).toHaveLength(events.length)
    expect(lines.every((l) => l.startsWith("phase="))).toBe(true)
    expect(lines).toContain("phase=tool.failed step=0 tool=broken_item reason=threw")

    // The return value is the caller's, and is not narrowed.
    expect(result.text).toContain(`${CANARY}-final`)
    expect(result.outcome).toBe("completed")
  })

  it("writes phase lines even when the caller attached no event sink", async () => {
    const lines: string[] = []
    await engine().run(spec({ private: true, provider: LOCAL }), { log: (l) => lines.push(l) })
    expect(lines[0]).toMatch(/^phase=run\.started /)
    expect(lines.join("\n")).not.toContain(CANARY)
  })

  it("replaces a thrown error with one that carries none of the material", async () => {
    const throwing: Loop = {
      name: "throwing",
      run: async () => {
        throw new Error(`provider echoed ${CANARY}-boom`)
      },
    }
    const lines: string[] = []
    const { sink, events } = recordRunEvents()
    const run = new NativeEngine({ loop: throwing }).run(spec({ private: true, provider: LOCAL }), {
      log: (l) => lines.push(l),
      emit: sink,
    })

    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrivateRunError)
    expect((err as PrivateRunError).phase).toBe("loop")
    expect((err as Error).message).not.toContain(CANARY)
    expect((err as Error).cause).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain(CANARY)
    expect(lines.join("\n")).not.toContain(CANARY)
    const finished = events.at(-1)
    expect(finished?.type === "run.finished" && finished.error).toBe(PRIVATE_REDACTION)
  })

  it("rethrows the original error untouched when NOT private", async () => {
    const throwing: Loop = {
      name: "throwing",
      run: async () => {
        throw new Error("plain failure")
      },
    }
    await expect(
      new NativeEngine({ loop: throwing }).run(spec(), { log: () => {} }),
    ).rejects.toThrow("plain failure")
  })
})

describe("NativeEngine holds a private run to local inference", () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
  })

  async function refused(run: RunSpec): Promise<string> {
    const engine = new NativeEngine({ loop: scriptedLoop, domainTools: () => tools })
    const support = engine.supports(run)
    expect(support.ok).toBe(false)
    // And at run start, for a caller that skipped supports(): nothing runs.
    const events: unknown[] = []
    const err = await engine
      .run(run, { log: () => {}, emit: (e) => events.push(e) })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(events).toEqual([])
    return support.ok ? "" : support.reason
  }

  it("refuses a private run that prefers a cloud provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    const reason = await refused(spec({ private: true, provider: { preferred: "anthropic" } }))
    expect(reason).toMatch(/"local"/)
  })

  it("refuses a private run with no preference, even with ambient cloud keys", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    await refused(spec({ private: true, provider: {} }))
  })

  it("refuses a private run that asks for the mock", async () => {
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    await refused(spec({ private: true, provider: { preferred: "mock" } }))
  })

  it("refuses a private run on local when LOCAL_MODEL_BASE_URL is unset", async () => {
    delete process.env.LOCAL_MODEL_BASE_URL
    const reason = await refused(spec({ private: true, provider: LOCAL }))
    expect(reason).toMatch(/LOCAL_MODEL_BASE_URL/)
  })

  it("runs a private run on a configured local provider", async () => {
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    const run = spec({ private: true, provider: LOCAL })
    const engine = new NativeEngine({ loop: scriptedLoop, domainTools: () => tools })
    expect(engine.supports(run)).toEqual({ ok: true })
    const result = await engine.run(run, { log: () => {} })
    expect(result.outcome).toBe("completed")
  })

  it("hands the loop the local provider, not another one", async () => {
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    process.env.ANTHROPIC_API_KEY = "sk-test"
    const seen: string[] = []
    const probe: Loop = {
      name: "probe",
      run: async (req) => {
        seen.push(req.model.id)
        return { text: "", steps: 0, outcome: "completed" }
      },
    }
    await new NativeEngine({ loop: probe }).run(spec({ private: true, provider: LOCAL }), {
      log: () => {},
    })
    expect(seen).toEqual(["local"])
  })
})

describe("privateRunChannels", () => {
  it("drops every free-text log line", () => {
    const lines: string[] = []
    const channels = privateRunChannels((l) => lines.push(l))
    channels.log(`tool x error: ${CANARY}`)
    expect(lines).toEqual([])
  })

  it("treats every tool name as unregistered before run.started is seen", () => {
    const { sink, events } = recordRunEvents()
    const channels = privateRunChannels(() => {}, sink)
    channels.emit({
      type: "tool.called",
      seq: 0,
      at: 0,
      step: 0,
      callId: "c",
      name: CANARY,
      input: { q: CANARY },
    })
    expect(JSON.stringify(events)).not.toContain(CANARY)
  })
})

describe("out-of-process engines refuse a private run", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  const ephemeral = spec({ private: true, workflow: { runner: { profile: "ephemeral" } } })

  it("claude-code", () => {
    process.env.RUNNER_ENABLE_CLAUDE_CODE = "1"
    const res = new ClaudeCodeEngine().supports(ephemeral)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toMatch(/private run/)
    // The same run without the flag is supported, so the flag is the reason.
    expect(new ClaudeCodeEngine().supports({ ...ephemeral, private: false })).toEqual({ ok: true })
  })

  it("codex", () => {
    process.env.RUNNER_ENABLE_CODEX = "1"
    const res = new CodexEngine(undefined, "/app/caps.js").supports(ephemeral)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toMatch(/private run/)
  })

  it("acp", () => {
    process.env[EVE_AGENT.enableEnv] = "1"
    const res = new AcpEngine(EVE_AGENT, "/app/caps.js").supports(ephemeral)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toMatch(/private run/)
  })

  it("native supports it when the local provider is configured", () => {
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1"
    expect(new NativeEngine().supports({ ...ephemeral, provider: LOCAL })).toEqual({ ok: true })
  })
})

describe("selectEngine forwards context providers to the native engine", () => {
  it("assembles context from the providers handed to selectEngine", async () => {
    const seen: (string | undefined)[] = []
    const provider: ContextProvider = {
      name: "live",
      assemble: async (s) => {
        seen.push(s.runId)
        return [{ source: "live", text: "fragment" }]
      },
    }
    const lines: string[] = []
    await selectEngine("native", { contextProviders: [provider] }).run(spec(), {
      log: (l) => lines.push(l),
    })
    expect(seen).toEqual(["r1"])
    expect(lines).toContain("context: 1 fragment(s) from 1 provider(s)")
  })
})
