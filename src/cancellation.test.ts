import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runAgent } from "./agent.js"
import {
  connectorTools,
  executeTool,
  primitiveTools,
  type Tool,
  type ToolContext,
} from "./tools/registry.js"
import { replaySafeTools } from "./tools/metadata.js"
import { modelAsTool } from "./tools/modelTool.js"
import { recordRunEvents, runEventEmitter, type RunEvent } from "./events.js"
import { runWithEvents, type Loop } from "./loop.js"
import { chatModel } from "./models/chat.js"
import type { ModelInvocation } from "./models/types.js"
import { MockProvider } from "./providers/mock.js"
import { AnthropicProvider, anthropicUsage } from "./providers/anthropic.js"
import { OpenAIProvider, openAIUsage } from "./providers/openai.js"
import type {
  ConverseOptions,
  ConverseRequest,
  ConverseResult,
  Provider,
} from "./providers/types.js"
import { httpFetch, type FetchImpl } from "./primitives/http.js"
import { runCode } from "./primitives/codeExec.js"
import { NativeEngine } from "./engines/native.js"
import {
  ClaudeCodeEngine,
  type ClaudeCodeMessage,
  type ClaudeCodeOptions,
} from "./engines/claudeCode.js"
import { CodexEngine, type CodexMessage, type CodexOptions } from "./engines/codex.js"
import { defaultCodexDriver } from "./engines/codexDriver.js"
import { AcpEngine, EVE_AGENT, acpRunOutcome, type AcpOptions } from "./engines/acp.js"
import type { RunSpec } from "./engines/types.js"
import { defaultAcpDriver, promptOutcome } from "./engines/acpDriver.js"
import type { ContextProvider } from "./context/types.js"
import { stopResult } from "./engines/claudeCodeDriver.js"
import type { McpConnection } from "./connectors/mcpClient.js"

/** Resolves when the signal aborts, rejecting with its reason — what an SDK does. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return // never settles: the test would time out, which is the failure
    if (signal.aborted) return reject(signal.reason as Error)
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true })
  })
}

/**
 * Turn 1 asks for a tool; every later turn hangs until its signal aborts. Counts
 * calls so a test can prove no summary call was made after the stop.
 */
class HangingProvider implements Provider {
  readonly name = "hanging"
  calls = 0
  signals: (AbortSignal | undefined)[] = []
  onHang?: () => void
  async complete(): Promise<string> {
    return ""
  }
  async converse(_req: ConverseRequest, opts?: ConverseOptions): Promise<ConverseResult> {
    this.calls += 1
    this.signals.push(opts?.signal)
    if (this.calls === 1) {
      return {
        text: "looked around",
        toolCalls: [{ id: "c1", name: "noop", input: {} }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    this.onHang?.()
    return untilAborted(opts?.signal)
  }
}

const noopTool: Tool = {
  spec: { name: "noop", description: "noop", inputSchema: { type: "object" } },
  execute: async () => "ok",
}

function finished(events: RunEvent[]): RunEvent | undefined {
  return events[events.length - 1]
}

describe("cancellation — the native loop", () => {
  it("a caller abort mid-call ends the run as canceled: no throw, no summary call", async () => {
    const provider = new HangingProvider()
    const controller = new AbortController()
    provider.onHang = () => controller.abort()
    const { sink, events } = recordRunEvents()

    const text = await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [noopTool],
      // Two steps: had the run merely hit its step budget, a third (summary)
      // call would follow. A cancel must not spend one.
      maxSteps: 2,
      signal: controller.signal,
      emit: sink,
    })

    expect(provider.calls).toBe(2)
    expect(text).toContain("looked around")
    expect(text).toContain("[run stopped: canceled]")
    expect(finished(events)).toMatchObject({ type: "run.finished", outcome: "canceled", steps: 1 })
    expect(events.some((e) => e.type === "run.budget_exhausted")).toBe(false)
    // The signal reached the provider's HTTP call, not just the loop.
    expect(provider.signals[1]?.aborted).toBe(true)
  })

  it("a deadline mid-step aborts the in-flight call and ends the run as timed_out", async () => {
    const provider = new HangingProvider()
    const { sink, events } = recordRunEvents()
    const started = Date.now()

    const text = await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [noopTool],
      maxDurationMs: 100,
      emit: sink,
    })

    // Before this, the deadline was only checked between steps, so a hung call
    // would hang the run; now it is aborted at the deadline.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(provider.calls).toBe(2)
    expect(text).toContain("wall-clock budget of 100ms exceeded")
    expect(events.some((e) => e.type === "run.budget_exhausted" && e.kind === "duration")).toBe(
      true,
    )
    expect(finished(events)).toMatchObject({ type: "run.finished", outcome: "timed_out" })
  })

  it("an abort before the first turn cancels without calling the model", async () => {
    const provider = new HangingProvider()
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [],
      signal: AbortSignal.abort("shutting down"),
      emit: sink,
    })
    expect(provider.calls).toBe(0)
    expect(finished(events)).toMatchObject({ outcome: "canceled", steps: 0 })
  })

  it("does not start another tool once the run is canceled", async () => {
    const controller = new AbortController()
    const ran: string[] = []
    const provider: Provider = {
      name: "two-tools",
      complete: async () => "",
      converse: async () => ({
        text: "",
        toolCalls: [
          { id: "a", name: "first", input: {} },
          { id: "b", name: "second", input: {} },
        ],
      }),
    }
    const tool = (name: string, effect: () => void): Tool => ({
      spec: { name, description: name, inputSchema: { type: "object" } },
      execute: async () => {
        ran.push(name)
        effect()
        return "ok"
      },
    })
    const { sink, events } = recordRunEvents()

    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [tool("first", () => controller.abort()), tool("second", () => {})],
      signal: controller.signal,
      emit: sink,
    })

    expect(ran).toEqual(["first"])
    expect(finished(events)).toMatchObject({ outcome: "canceled" })
  })

  it("an abort mid-run_code kills the whole process group", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-cancel-"))
    try {
      const pidFile = path.join(dir, "child.pid")
      const controller = new AbortController()
      // The shell backgrounds a grandchild and waits on it: killing only the
      // shell would orphan `sleep`, so this proves the GROUP is killed.
      const command = `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`
      let turns = 0
      const provider: Provider = {
        name: "runner",
        complete: async () => "",
        converse: async () => {
          turns += 1
          return turns === 1
            ? {
                text: "running it",
                toolCalls: [{ id: "rc", name: "run_code", input: { command } }],
              }
            : { text: "unreachable", toolCalls: [] }
        },
      }
      const poll = setInterval(() => {
        if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) controller.abort()
      }, 10)
      const { sink, events } = recordRunEvents()

      try {
        await runAgent({
          provider,
          system: "s",
          userPrompt: "go",
          tools: primitiveTools(dir, {}, ["run_code"]),
          signal: controller.signal,
          emit: sink,
        })
      } finally {
        clearInterval(poll)
      }

      expect(finished(events)).toMatchObject({ outcome: "canceled" })
      // The tool was stopped by the run, not broken: the stream says so.
      expect(events.find((e) => e.type === "tool.failed")).toMatchObject({
        callId: "rc",
        reason: "aborted",
      })
      expect(turns).toBe(1)
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      expect(await processGone(pid)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("closes a custom loop that throws on abort as canceled, and still rethrows", async () => {
    const throwing: Loop = {
      name: "throws-on-abort",
      run: async (_req, ctx) => untilAborted(ctx.signal),
    }
    const { sink, events } = recordRunEvents()
    const controller = new AbortController()
    const run = runWithEvents(
      throwing,
      {
        model: chatModel(new MockProvider()),
        system: "s",
        userPrompt: "go",
        tools: [],
        limits: { maxSteps: 1, maxDurationMs: 60_000 },
      },
      { log: () => {}, events: runEventEmitter(sink), signal: controller.signal },
    )
    controller.abort(new Error("stop"))
    await expect(run).rejects.toThrow("stop")
    expect(finished(events)).toMatchObject({ outcome: "canceled", error: "stop" })
  })

  it("still records a real failure after the abort as failed", async () => {
    const buggy: Loop = {
      name: "buggy",
      run: async () => {
        throw new TypeError("undefined is not a function")
      },
    }
    const { sink, events } = recordRunEvents()
    const run = runWithEvents(
      buggy,
      {
        model: chatModel(new MockProvider()),
        system: "s",
        userPrompt: "go",
        tools: [],
        limits: { maxSteps: 1, maxDurationMs: 60_000 },
      },
      { log: () => {}, events: runEventEmitter(sink), signal: AbortSignal.abort() },
    )
    await expect(run).rejects.toThrow(TypeError)
    expect(finished(events)).toMatchObject({ outcome: "failed" })
  })
})

/** True once `pid` no longer exists, or exists only as a zombie awaiting reaping. */
async function processGone(pid: number, attempts = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      process.kill(pid, 0)
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return true
      } catch {
        return true
      }
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

describe("cancellation — tool context", () => {
  it("hands each tool its callId, the run's signal and the runId", async () => {
    const seen: (ToolContext | undefined)[] = []
    const tool: Tool = {
      spec: { name: "probe", description: "probe", inputSchema: { type: "object" } },
      execute: async (_input, ctx) => {
        seen.push(ctx)
        return "ok"
      },
    }
    let turns = 0
    const provider: Provider = {
      name: "p",
      complete: async () => "",
      converse: async () => {
        turns += 1
        return turns === 1
          ? { text: "", toolCalls: [{ id: "call-7", name: "probe", input: {} }] }
          : { text: "done", toolCalls: [] }
      },
    }

    await runAgent({ provider, system: "s", userPrompt: "go", tools: [tool], runId: "run-42" })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.callId).toBe("call-7")
    expect(seen[0]?.runId).toBe("run-42")
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.signal.aborted).toBe(false)
  })

  it("passes ctx to executeStructured too", async () => {
    let got: ToolContext | undefined
    const tool: Tool = {
      spec: { name: "s", description: "s", inputSchema: { type: "object" } },
      execute: async () => "unused",
      executeStructured: async (_input, ctx) => {
        got = ctx
        return { content: "x" }
      },
    }
    const ctx: ToolContext = { signal: new AbortController().signal, callId: "c" }
    await executeTool(tool, {}, ctx)
    expect(got).toBe(ctx)
  })

  it("forwards the signal to the MCP request", async () => {
    let opts: { signal?: AbortSignal } | undefined
    const conn: McpConnection = {
      listTools: async () => ({ tools: [{ name: "do" }] }),
      callTool: async (_name, _args, o) => {
        opts = o
        return { ok: true }
      },
      close: async () => {},
    }
    const { tools, close } = await connectorTools(
      [{ name: "svc", kind: "mcp", transport: "stdio", command: "x" }],
      async () => conn,
    )
    const signal = new AbortController().signal
    await tools[0]!.execute({}, { signal, callId: "c" })
    expect(opts?.signal).toBe(signal)
    await close()
  })

  it("modelAsTool forwards the run's signal to the model invocation", async () => {
    let received: AbortSignal | undefined
    const model: ModelInvocation<Record<string, unknown>, string> = {
      id: "m",
      kind: "vision.detect",
      caps: { streaming: false, tools: false, multimodalInput: false, usage: false },
      invoke: async (_req, ctx) => {
        received = ctx.signal
        return { value: "seen" }
      },
      probe: async () => ({ status: "up" }),
    }
    const tool = modelAsTool(model, {
      name: "detect",
      description: "d",
      inputSchema: { type: "object" },
      toRequest: (input) => input,
    })
    const controller = new AbortController()
    await tool.execute({}, { signal: controller.signal, callId: "c" })
    expect(received).toBeDefined()
    controller.abort()
    expect(received?.aborted).toBe(true)
  })

  it("runCode rejects without spawning when already aborted", async () => {
    await expect(
      runCode({
        cwd: tmpdir(),
        command: "/bin/sh",
        args: ["-c", "true"],
        signal: AbortSignal.abort("no"),
      }),
    ).rejects.toThrow("run_code aborted: no")
  })

  it("httpFetch reports an already-aborted signal as `http aborted` too", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      throw new Error("unreachable")
    }) as unknown as FetchImpl
    await expect(
      httpFetch({
        url: "https://api.example.com/x",
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/http aborted: https:\/\/api\.example\.com\/x/)
    expect(called).toBe(false)
  })

  it("httpFetch aborts an in-flight request as `http aborted`, not a timeout", async () => {
    const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) =>
      untilAborted(init?.signal)) as unknown as FetchImpl
    const controller = new AbortController()
    const pending = httpFetch({
      url: "https://api.example.com/x",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toThrow(/http aborted/)
  })
})

describe("replay metadata", () => {
  const safe: Tool = {
    spec: { name: "read", description: "r", inputSchema: { type: "object" } },
    meta: { replay: "safe" },
    execute: async () => "ok",
  }
  const unsafe: Tool = {
    spec: { name: "send", description: "s", inputSchema: { type: "object" } },
    meta: { replay: "unsafe" },
    execute: async () => "ok",
  }
  const undeclared: Tool = {
    spec: { name: "other", description: "o", inputSchema: { type: "object" } },
    execute: async () => "ok",
  }

  it("replaySafeTools keeps only tools that declared safe — absent means unsafe", () => {
    expect(replaySafeTools([safe, unsafe, undeclared]).map((t) => t.spec.name)).toEqual(["read"])
  })

  it("copies replay onto tool.called and tool.succeeded, and omits it when undeclared", async () => {
    let turns = 0
    const provider: Provider = {
      name: "p",
      complete: async () => "",
      converse: async () => {
        turns += 1
        return turns === 1
          ? {
              text: "",
              toolCalls: [
                { id: "1", name: "read", input: {} },
                { id: "2", name: "other", input: {} },
              ],
            }
          : { text: "done", toolCalls: [] }
      },
    }
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [safe, undeclared],
      emit: sink,
    })

    const called = events.filter((e) => e.type === "tool.called")
    const succeeded = events.filter((e) => e.type === "tool.succeeded")
    expect(called[0]).toMatchObject({ name: "read", replay: "safe" })
    expect(succeeded[0]).toMatchObject({ name: "read", replay: "safe" })
    expect(called[1]).not.toHaveProperty("replay")
  })
})

describe("usage", () => {
  it("maps Anthropic and OpenAI usage blocks to token usage", () => {
    expect(anthropicUsage({ input_tokens: 12, output_tokens: 3 })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    })
    expect(anthropicUsage(undefined)).toBeUndefined()
    expect(openAIUsage({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
    })
    expect(openAIUsage(null)).toBeUndefined()
  })

  it("chatModel declares usage only for providers that report it", () => {
    expect(chatModel(new MockProvider()).caps.usage).toBe(false)
    expect(chatModel(new AnthropicProvider("sk-test")).caps.usage).toBe(true)
    expect(chatModel(new OpenAIProvider("sk-test")).caps.usage).toBe(true)
  })

  it("chatModel lifts reported usage onto ModelResult.usage", async () => {
    const provider: Provider = {
      name: "p",
      reportsUsage: true,
      complete: async () => "",
      converse: async () => ({
        text: "hi",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    }
    const model = chatModel(provider)
    expect(model.caps.usage).toBe(true)
    const result = await model.invoke({ system: "s", messages: [], tools: [] }, { log: () => {} })
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it("puts usage on model.turn when the model reported it", async () => {
    const provider = new HangingProvider()
    const controller = new AbortController()
    provider.onHang = () => controller.abort()
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [noopTool],
      signal: controller.signal,
      emit: sink,
    })
    const turn = events.find((e) => e.type === "model.turn")
    expect(turn).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
  })

  it("the mock provider honours an aborted signal", async () => {
    await expect(
      new MockProvider().converse(
        { system: "s", messages: [], tools: [] },
        { signal: AbortSignal.abort("stop") },
      ),
    ).rejects.toBe("stop")
  })
})

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing.", runner: { profile: "ephemeral" } },
    inputs: {},
    context: "",
    // A placeholder, never the OS temp dir: these engines hand `workdir` to
    // `write_file`, and nothing here should write anywhere real.
    workdir: "/sandbox/x",
    permissions: { tools: [] },
    secrets: {},
    connectors: [],
    provider: { preferred: "mock" },
    ...overrides,
  }
}

describe("EngineResult.outcome", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("NativeEngine reports the loop's outcome", async () => {
    const engine = new NativeEngine()
    const done = await engine.run(spec(), { log: () => {} })
    expect(done.outcome).toBe("completed")

    const canceled = await engine.run(spec(), { log: () => {}, signal: AbortSignal.abort() })
    expect(canceled.outcome).toBe("canceled")
  })

  it("ClaudeCodeEngine passes the signal and maps the driver's stop", async () => {
    let captured: ClaudeCodeOptions | undefined
    const make = (last: ClaudeCodeMessage) =>
      async function* (opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
        captured = opts
        yield { kind: "assistant", text: "partial work" }
        yield last
      }
    const signal = new AbortController().signal

    const ok = await new ClaudeCodeEngine(
      make({ kind: "result", text: "done", isError: false }),
    ).run(spec(), { log: () => {}, signal })
    expect(captured?.signal).toBe(signal)
    expect(ok.outcome).toBe("completed")

    const timedOut = await new ClaudeCodeEngine(
      make({ kind: "result", text: "", isError: true, stoppedBy: "deadline" }),
    ).run(spec(), { log: () => {} })
    expect(timedOut).toMatchObject({ outcome: "timed_out", text: "partial work" })

    const canceled = await new ClaudeCodeEngine(
      make({ kind: "result", text: "", isError: true, stoppedBy: "signal" }),
    ).run(spec(), { log: () => {} })
    expect(canceled.outcome).toBe("canceled")

    const failed = await new ClaudeCodeEngine(
      make({ kind: "result", text: "boom", isError: true }),
    ).run(spec(), { log: () => {} })
    expect(failed.outcome).toBe("failed")
  })

  it("ClaudeCodeEngine treats a driver that throws on the caller's abort as canceled", async () => {
    const controller = new AbortController()
    // eslint-disable-next-line require-yield
    async function* driver(): AsyncIterable<ClaudeCodeMessage> {
      controller.abort()
      throw new Error("aborted by sdk")
    }
    const result = await new ClaudeCodeEngine(driver).run(spec(), {
      log: () => {},
      signal: controller.signal,
    })
    expect(result.outcome).toBe("canceled")
  })

  it("CodexEngine passes the signal and maps the driver's stop", async () => {
    let captured: CodexOptions | undefined
    async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
      captured = opts
      yield { kind: "result", text: "partial", isError: true, stoppedBy: "deadline" }
    }
    const signal = new AbortController().signal
    const result = await new CodexEngine(driver, "/opt/script.js").run(spec(), {
      log: () => {},
      signal,
    })
    expect(captured?.signal).toBe(signal)
    expect(result.outcome).toBe("timed_out")
  })

  it("AcpEngine passes the signal and maps the turn's ending", async () => {
    let captured: AcpOptions | undefined
    const signal = new AbortController().signal
    const engine = new AcpEngine(EVE_AGENT, "/opt/script.js", async (opts) => {
      captured = opts
      return { stopReason: "cancelled", stoppedBy: "signal" }
    })
    const result = await engine.run(spec(), { log: () => {}, signal })
    expect(captured?.signal).toBe(signal)
    expect(result.outcome).toBe("canceled")

    expect(acpRunOutcome({ stopReason: "end_turn" })).toBe("completed")
    expect(acpRunOutcome({ stopReason: "cancelled", stoppedBy: "deadline" })).toBe("timed_out")
    expect(acpRunOutcome({ stopReason: "max_turn_requests" })).toBe("steps_exhausted")
    expect(acpRunOutcome({ stopReason: "refusal" })).toBe("failed")
  })

  it("a stop landing after a clean finish never relabels the run", () => {
    // ACP: only an agent-answered `cancelled` is credited to the stopper.
    expect(promptOutcome("end_turn", "signal")).toEqual({ stopReason: "end_turn" })
    expect(promptOutcome("cancelled", "deadline")).toEqual({
      stopReason: "cancelled",
      stoppedBy: "deadline",
    })
    // claude-code: nothing is added after a clean result…
    expect(stopResult({ kind: "result", text: "done", isError: false }, "signal")).toBeUndefined()
    expect(stopResult(undefined, undefined)).toBeUndefined()
    // …and an error result's own text survives the synthesized stop.
    expect(
      stopResult({ kind: "result", text: "harness said why", isError: true }, "deadline"),
    ).toEqual({ kind: "result", text: "harness said why", isError: true, stoppedBy: "deadline" })
    expect(stopResult(undefined, "signal")).toEqual({
      kind: "result",
      text: "",
      isError: true,
      stoppedBy: "signal",
    })
  })
})

describe("review round 2", () => {
  it("force-stops an ACP agent that ignores session/cancel", async () => {
    // A minimal ACP agent over stdio: answers initialize + session/new, then
    // never answers session/prompt and ignores session/cancel — a hung agent.
    const agent = `
      const rl = require("node:readline").createInterface({ input: process.stdin })
      rl.on("line", (line) => {
        const msg = JSON.parse(line)
        const reply = (result) =>
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n")
        if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: {} })
        else if (msg.method === "session/new") reply({ sessionId: "s1" })
      })
    `
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const outcome = await defaultAcpDriver(
      {
        command: process.execPath,
        args: ["-e", agent],
        env: {},
        cwd: tmpdir(),
        mcpServers: [],
        prompt: "go",
        log: () => {},
        signal: controller.signal,
        cancelGraceMs: 100,
      },
      { onAssistantChunk: () => {}, onLog: () => {} },
    )
    expect(outcome).toEqual({ stopReason: "cancelled", stoppedBy: "signal" })
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 8_000)

  it("NativeEngine returns canceled without connecting when already aborted", async () => {
    const result = await new NativeEngine().run(
      spec({
        // Would fail loudly if the engine tried to connect it.
        connectors: [{ name: "svc", kind: "mcp", transport: "stdio", command: "/nonexistent/x" }],
      }),
      { log: () => {}, signal: AbortSignal.abort() },
    )
    expect(result.outcome).toBe("canceled")
  })

  it("NativeEngine honours a cancel while setup is stalled", async () => {
    const stalled: ContextProvider = { name: "stalled", assemble: () => new Promise(() => {}) }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const result = await new NativeEngine({ contextProviders: [stalled] }).run(spec(), {
      log: () => {},
      signal: controller.signal,
    })
    expect(result.outcome).toBe("canceled")
  }, 4_000)

  it("Anthropic usage counts cached input, with the cache split out", () => {
    expect(
      anthropicUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      }),
    ).toEqual({
      inputTokens: 130,
      outputTokens: 5,
      totalTokens: 135,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
    })
  })

  it("OpenAI usage splits out cached prompt tokens", () => {
    expect(
      openAIUsage({
        prompt_tokens: 50,
        completion_tokens: 5,
        total_tokens: 55,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheReadTokens: 40 })
  })

  it("labels a tool's own failure as threw even if the run is aborted meanwhile", async () => {
    const controller = new AbortController()
    const tool: Tool = {
      spec: { name: "flaky", description: "f", inputSchema: { type: "object" } },
      execute: async () => {
        controller.abort()
        throw new Error("disk full")
      },
    }
    const provider: Provider = {
      name: "p",
      complete: async () => "",
      converse: async () => ({ text: "", toolCalls: [{ id: "f1", name: "flaky", input: {} }] }),
    }
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [tool],
      signal: controller.signal,
      emit: sink,
    })
    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({ reason: "threw" })
  })
})

describe("review round 3", () => {
  it("a reply that arrives after the caller canceled still ends the run canceled", async () => {
    const controller = new AbortController()
    // Ignores its signal: aborts the run, then answers with a terminal turn anyway.
    const provider: Provider = {
      name: "deaf",
      complete: async () => "",
      converse: async () => {
        controller.abort()
        return { text: "late answer", toolCalls: [] }
      },
    }
    const { sink, events } = recordRunEvents()
    const text = await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [],
      signal: controller.signal,
      emit: sink,
    })
    // The turn happened and is recorded; its prose is kept; the outcome is the stop's.
    expect(events.some((e) => e.type === "model.turn" && e.text === "late answer")).toBe(true)
    expect(text).toContain("late answer")
    expect(finished(events)).toMatchObject({ outcome: "canceled", steps: 1 })
  })

  it("a model failure that merely coincides with the abort still propagates", async () => {
    const controller = new AbortController()
    const provider: Provider = {
      name: "broken",
      complete: async () => "",
      converse: async () => {
        controller.abort()
        throw new Error("500 upstream exploded")
      },
    }
    const { sink, events } = recordRunEvents()
    await expect(
      runAgent({
        provider,
        system: "s",
        userPrompt: "go",
        tools: [],
        signal: controller.signal,
        emit: sink,
      }),
    ).rejects.toThrow("500 upstream exploded")
    expect(finished(events)).toMatchObject({ outcome: "failed" })
  })

  it("treats an SDK's own abort error as the abort", async () => {
    class APIUserAbortError extends Error {}
    const controller = new AbortController()
    const provider: Provider = {
      name: "sdk",
      complete: async () => "",
      converse: async () => {
        controller.abort()
        throw new APIUserAbortError("Request was aborted.")
      },
    }
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider,
      system: "s",
      userPrompt: "go",
      tools: [],
      signal: controller.signal,
      emit: sink,
    })
    expect(finished(events)).toMatchObject({ outcome: "canceled" })
  })

  it("connectorTools closes already-open connections when canceled mid-setup", async () => {
    let closed = 0
    const open: McpConnection = {
      listTools: async () => ({ tools: [{ name: "a" }] }),
      callTool: async () => ({}),
      close: async () => {
        closed += 1
      },
    }
    const controller = new AbortController()
    let calls = 0
    const connect = (): Promise<McpConnection> => {
      calls += 1
      if (calls === 1) return Promise.resolve(open)
      setTimeout(() => controller.abort(), 10)
      return new Promise(() => {}) // the second server never answers
    }
    await expect(
      connectorTools(
        [
          { name: "one", kind: "mcp", transport: "stdio", command: "x" },
          { name: "two", kind: "mcp", transport: "stdio", command: "y" },
        ],
        connect,
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined()
    expect(closed).toBe(1)
  }, 4_000)

  it("the codex driver force-kills a codex process group that ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-codex-stop-"))
    const savedPath = process.env.PATH
    try {
      const pidFile = path.join(dir, "child.pid")
      // A stand-in `codex` that ignores SIGTERM and leaves a grandchild behind.
      writeFileSync(
        path.join(dir, "codex"),
        `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho $! > "$PIDFILE"\nwait\n`,
        { mode: 0o755 },
      )
      process.env.PATH = `${dir}:${savedPath ?? ""}`
      const controller = new AbortController()
      const poll = setInterval(() => {
        if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) controller.abort()
      }, 10)
      const messages: CodexMessage[] = []
      try {
        for await (const m of defaultCodexDriver({
          prompt: "go",
          cwd: dir,
          model: "m",
          codexHome: dir,
          capabilityEnv: { PIDFILE: pidFile },
          signal: controller.signal,
          cancelGraceMs: 200,
        })) {
          messages.push(m)
        }
      } finally {
        clearInterval(poll)
      }
      expect(messages.at(-1)).toMatchObject({ kind: "result", stoppedBy: "signal" })
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      // Gone by the time the driver returns — not merely signalled.
      expect(await processGone(pid, 1)).toBe(true)
    } finally {
      process.env.PATH = savedPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 8_000)
})
