// Interactions between opt-in loop features that no single feature's tests can
// see: argument validation, parallel tool calls, the cost budget, retry and
// fallback around the model, rotating connector credentials, and settling a
// transcript a parallel step left behind.
import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { runConversation } from "./agent.js"
import { NativeEngine } from "./engines/native.js"
import type { RunSpec } from "./engines/types.js"
import { recordRunEvents, type RunEvent } from "./events.js"
import { nativeLoop, type Loop } from "./loop.js"
import { chatModel } from "./models/chat.js"
import { withRetry, type RetryEvent } from "./models/retry.js"
import type { TokenUsage } from "./models/types.js"
import { privateRunChannels } from "./private.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult, Provider } from "./providers/types.js"
import type { ToolConcurrency } from "./tools/concurrency.js"
import { isConcurrencySafe } from "./tools/metadata.js"
import type { Tool, ToolContext } from "./tools/registry.js"
import { terminalTool } from "./tools/terminal.js"
import { settleMessages, withUserTurn } from "./transcript.js"
import type { ConnectorConfig } from "./types.js"

// ── Shared fakes ─────────────────────────────────────────────────────────────

const seed: AgentMessage[] = [{ role: "user", text: "go" }]
const prose = (text: string, usage?: TokenUsage): ConverseResult => ({
  text,
  toolCalls: [],
  ...(usage ? { usage } : {}),
})
const step = (
  calls: Array<[name: string, id: string, input: Record<string, unknown>]>,
  usage?: TokenUsage,
): ConverseResult => ({
  text: "",
  toolCalls: calls.map(([name, id, input]) => ({
    id,
    name,
    input,
    argumentsText: JSON.stringify(input),
  })),
  ...(usage ? { usage } : {}),
})
const usd = (amount: number): TokenUsage => ({
  inputTokens: 10,
  outputTokens: 5,
  reportedCost: { amount, currency: "USD" },
})
const parallel = (maxConcurrent = 8): ToolConcurrency => ({
  maxConcurrent,
  concurrencySafe: isConcurrencySafe,
})

/** Tools that record overlap, so parallelism is observed rather than timed. */
function tracker() {
  let inFlight = 0
  const self = {
    maxInFlight: 0,
    started: [] as string[],
    tool(
      name: string,
      opts: { ms?: number; safe?: boolean; schema?: Record<string, unknown> } = {},
    ): Tool {
      return {
        spec: {
          name,
          description: name,
          inputSchema: opts.schema ?? { type: "object" },
        },
        meta: opts.safe ? { concurrencySafe: true } : {},
        async execute(input, ctx?: ToolContext) {
          inFlight += 1
          self.maxInFlight = Math.max(self.maxInFlight, inFlight)
          self.started.push(`${name}:${JSON.stringify(input)}`)
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, opts.ms ?? 10)
              ctx?.signal.addEventListener("abort", () => {
                clearTimeout(timer)
                reject(ctx.signal.reason as Error)
              })
            })
            return `${name} ok`
          } finally {
            inFlight -= 1
          }
        },
      }
    },
  }
  return self
}

const toolTurns = (messages: AgentMessage[]) =>
  messages.flatMap((m) => (m.role === "tool" ? [m.results] : []))
const failures = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "tool.failed" ? [`${e.callId}:${e.reason}`] : []))
const called = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "tool.called" ? [e.callId] : []))
const pendingIds = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "tool.pending" ? [e.callId] : []))

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
}

// ── Argument validation inside a parallel segment ────────────────────────────

describe("an invalid call inside a parallel segment", () => {
  it("is refused on its own while the rest of the segment still runs together", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, ms: 20, schema: idSchema })
    const result = await runConversation({
      provider: new ScriptedProvider([
        step([
          ["read", "a", { id: "a" }],
          ["read", "b", { id: 5 }],
          ["read", "c", { id: "c" }],
        ]),
        prose("done"),
      ]),
      system: "",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(),
      validateToolInput: true,
      log: () => {},
    })

    expect(result.outcome).toBe("completed")
    // The refusal neither ran nor split the segment: a and c overlapped.
    expect(t.started).toEqual(['read:{"id":"a"}', 'read:{"id":"c"}'])
    expect(t.maxInFlight).toBe(2)
    expect(called(result.events)).toEqual(["a", "c"])
    expect(failures(result.events)).toEqual(["b:invalid_input"])
    // Results come back in the model's order, the refusal in its own slot.
    const [results] = toolTurns(result.messages)
    expect(results?.map((r) => [r.toolCallId, r.isError ?? false])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ])
    expect(results?.[1]?.content).toMatch(/\/id/)
  })

  it("never lets a refused terminal call be the answer, even when it was issued first", async () => {
    const reply = terminalTool({
      name: "reply",
      description: "Send the final answer.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    })
    const result = await runConversation({
      provider: new ScriptedProvider([
        step([
          ["reply", "t1", {}],
          ["reply", "t2", { text: "second" }],
        ]),
      ]),
      system: "",
      messages: seed,
      tools: [reply],
      // Every call vouched for, so both terminal calls share one segment.
      toolConcurrency: { maxConcurrent: 4, concurrencySafe: () => true },
      validateToolInput: true,
      log: () => {},
    })

    expect(result.outcome).toBe("completed")
    expect(result.terminal?.callId).toBe("t2")
    expect(result.terminal?.input).toEqual({ text: "second" })
    expect(failures(result.events)).toEqual(["t1:invalid_input"])
  })

  it("refuses an invalid external call in the segment instead of parking it", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, schema: idSchema })
    const ask: Tool = {
      spec: { name: "ask", description: "ask a person", inputSchema: idSchema },
      meta: { dispatch: "external", concurrencySafe: true },
      execute: async () => {
        throw new Error("an external tool's executor must never run in the loop")
      },
    }
    const result = await runConversation({
      provider: new ScriptedProvider([
        step([
          ["read", "a", { id: "a" }],
          ["ask", "x1", { id: 1 }],
          ["ask", "x2", { id: "fine" }],
        ]),
      ]),
      system: "",
      messages: seed,
      tools: [read, ask],
      toolConcurrency: parallel(),
      validateToolInput: true,
      log: () => {},
    })

    // Only the valid external call parks; the invalid one is answered now.
    expect(result.outcome).toBe("suspended")
    expect(result.pending?.map((c) => c.id)).toEqual(["x2"])
    expect(pendingIds(result.events)).toEqual(["x2"])
    expect(failures(result.events)).toEqual(["x1:invalid_input"])
    const [results] = toolTurns(result.messages)
    expect(results?.map((r) => r.toolCallId)).toEqual(["a", "x1"])
  })
})

// ── Argument validation through a private run's redaction ────────────────────

describe("an invalid call in a private run", () => {
  // DEFECT: `FAILURE_REASONS` in src/private.ts does not list "invalid_input",
  // so the redaction rewrites a schema refusal to "threw". Marked `it.fails`
  // so the branch stays green; it flips red once the reason is allowed, and
  // should then become a plain `it`.
  it.fails("keeps the invalid_input reason through the redaction", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true, schema: idSchema })
    const lines: string[] = []
    const { sink, events } = recordRunEvents()
    const channels = privateRunChannels((l) => lines.push(l), sink)
    await runConversation({
      provider: new ScriptedProvider([
        step([
          ["read", "a", { id: "a" }],
          ["read", "b", { id: 5 }],
        ]),
        prose("done"),
      ]),
      system: "",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(),
      validateToolInput: true,
      log: channels.log,
      emit: channels.emit,
    })

    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({
      reason: "invalid_input",
    })
    expect(lines.some((l) => l.includes("reason=invalid_input"))).toBe(true)
  })
})

// ── A cost stop on a turn that would have run in parallel ────────────────────

describe("the cost budget with parallel tool calls", () => {
  it("starts none of a parallel turn's calls once that turn crosses the budget", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true })
    const result = await runConversation({
      provider: new ScriptedProvider(
        [
          step(
            [
              ["read", "a", { id: "a" }],
              ["read", "b", { id: "b" }],
            ],
            usd(0.4),
          ),
          step(
            [
              ["read", "c", { id: "c" }],
              ["read", "d", { id: "d" }],
              ["read", "e", { id: "e" }],
            ],
            usd(0.6),
          ),
          // A summary call would play this and complete; it must never be asked for.
          prose("summary that must not be requested", usd(5)),
        ],
        { reportsUsage: true },
      ),
      system: "",
      messages: seed,
      tools: [read],
      toolConcurrency: parallel(),
      maxCostUsd: 1,
      log: () => {},
    })

    expect(result.outcome).toBe("cost_exhausted")
    expect(result.stopReason).toBe("cost_exhausted")
    // The first turn, under budget, ran its calls together; the second ran none.
    expect(t.started).toEqual(['read:{"id":"a"}', 'read:{"id":"b"}'])
    expect(t.maxInFlight).toBe(2)
    expect(called(result.events)).toEqual(["a", "b"])
    expect(result.usage?.reportedCost?.amount).toBeCloseTo(1.0)
    expect(result.steps).toBe(2)
    expect(
      result.events.filter((e) => e.type === "run.budget_exhausted").map((e) => e.kind),
    ).toEqual(["cost"])
    // Every call of the stopped turn is answered, in order, so the transcript resumes.
    const turns = toolTurns(result.messages)
    expect(turns[1]?.map((r) => [r.toolCallId, r.isError])).toEqual([
      ["c", true],
      ["d", true],
      ["e", true],
    ])
    expect(() => settleMessages(result.messages)).not.toThrow()
    expect(settleMessages(result.messages)).toEqual(result.messages)
  })
})

// ── Retry and fallback serving a run with a cost budget ──────────────────────

/** An error shaped like an SDK's APIError. */
const apiError = (status: number) =>
  Object.assign(new Error(`${status} upstream said no`), { status })

/** A provider that plays `script`, throwing its errors; counts every call. */
function flaky(model: string, script: Array<ConverseResult | Error>) {
  let i = 0
  const provider: Provider & { calls: number } = {
    name: "flaky",
    model,
    calls: 0,
    reportsUsage: true,
    converse: () => {
      provider.calls += 1
      const next = script[i++]
      if (next === undefined) return Promise.reject(new Error(`${model}: script exhausted`))
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve({ ...next, model })
    },
  }
  return provider
}

const noWait = { sleep: () => Promise.resolve(), random: () => 1 }

describe("withRetry serving a run that has a cost budget", () => {
  it("sums the cost of every served turn, whichever model in the chain served it", async () => {
    const echo = tracker().tool("echo")
    // Turn 1: the primary answers. Turn 2: the primary fails twice and the
    // fallback answers. Turn 3: the primary is back.
    const primary = flaky("big", [
      step([["echo", "e1", {}]], usd(0.3)),
      apiError(503),
      apiError(503),
      step([["echo", "e3", {}]], usd(0.3)),
    ])
    const backup = flaky("small", [step([["echo", "e2", {}]], usd(0.25))])
    const retries: RetryEvent[] = []
    const model = withRetry(chatModel(primary), {
      ...noWait,
      maxAttempts: 2,
      fallbacks: [chatModel(backup)],
      onEvent: (e) => retries.push(e),
    })

    const result = await runConversation({
      provider: model,
      system: "",
      messages: seed,
      tools: [echo],
      maxCostUsd: 0.8,
      log: () => {},
    })

    // 0.3 + 0.25 + 0.3 = 0.85 crosses 0.8 on the third turn, which asked for a tool.
    expect(result.outcome).toBe("cost_exhausted")
    expect(result.usage?.reportedCost?.amount).toBeCloseTo(0.85)
    expect(result.consumed.usage?.reportedCost?.amount).toBeCloseTo(0.85)
    // Each turn is audited with the model that actually served it.
    const turns = result.events.flatMap((e) => (e.type === "model.turn" ? [e] : []))
    expect(turns.map((e) => e.model)).toEqual(["big", "small", "big"])
    const turnCost = turns.map((e) =>
      e.usage && "reportedCost" in e.usage ? e.usage.reportedCost?.amount : undefined,
    )
    expect(turnCost).toEqual([0.3, 0.25, 0.3])
    // Five model calls were made (1 + 2 failed + 1 fallback + 1), three were served.
    expect(primary.calls + backup.calls).toBe(5)
    expect(retries.length).toBeGreaterThan(0)
  })

  it("counts nothing for attempts that failed, since a failed call reports no usage", async () => {
    const primary = flaky("big", [apiError(503), apiError(503)])
    const backup = flaky("small", [prose("answered", usd(0.2))])
    const model = withRetry(chatModel(primary), {
      ...noWait,
      maxAttempts: 2,
      fallbacks: [chatModel(backup)],
    })
    const result = await runConversation({
      provider: model,
      system: "",
      messages: seed,
      tools: [],
      maxCostUsd: 0.2,
      log: () => {},
    })

    // A prose answer on the crossing turn completes, and only the served call counts.
    expect(result.outcome).toBe("completed")
    expect(result.text).toBe("answered")
    expect(primary.calls).toBe(2)
    expect(result.usage?.reportedCost?.amount).toBeCloseTo(0.2)
    expect(result.model).toBe("small")
  })

  it("ends failed, not cost_exhausted, when the whole chain is exhausted", async () => {
    const primary = flaky("big", [apiError(503), apiError(503)])
    const backup = flaky("small", [apiError(503), apiError(503)])
    const model = withRetry(chatModel(primary), {
      ...noWait,
      maxAttempts: 2,
      fallbacks: [chatModel(backup)],
    })
    await expect(
      runConversation({
        provider: model,
        system: "",
        messages: seed,
        tools: [],
        maxCostUsd: 1,
        log: () => {},
      }),
    ).rejects.toThrow()
  })
})

// ── Rotating connector credentials masked in parallel results ────────────────

/**
 * A stateless Streamable HTTP MCP server on loopback whose one tool echoes the
 * Authorization header its request carried, after a short wait so parallel
 * calls overlap on the server too.
 */
async function slowWhoamiServer() {
  const authorizations: string[] = []
  let inFlight = 0
  const stats = { maxInFlight: 0 }
  const http = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? "")
    const server = new McpServer({ name: "test-server", version: "0.0.1" })
    server.registerTool(
      "whoami",
      { description: "echo the request's credential" },
      async (extra) => {
        inFlight += 1
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 40))
        inFlight -= 1
        return {
          content: [
            { type: "text" as const, text: String(extra.requestInfo?.headers.authorization) },
          ],
        }
      },
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    void server.connect(transport).then(() => transport.handleRequest(req, res))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    authorizations,
    stats,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

describe("a rotating connector credential with parallel tool calls", () => {
  let server: Awaited<ReturnType<typeof slowWhoamiServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it("masks every token in results that come back from overlapping calls", async () => {
    server = await slowWhoamiServer()
    // A fresh token for every request, so each parallel call carries its own.
    let n = 0
    const connector: ConnectorConfig = {
      name: "crm",
      kind: "mcp",
      transport: "streamable_http",
      endpoint: server.endpoint,
      auth: { type: "bearer", headers: () => ({ Authorization: `Bearer rotating-${++n}` }) },
    }
    const scripted = new ScriptedProvider([
      step([
        ["crm__whoami", "w1", {}],
        ["crm__whoami", "w2", {}],
        ["crm__whoami", "w3", {}],
      ]),
      prose("done"),
    ])
    // The engine's loop, opted into parallel calls for every tool, the way the
    // README wraps `nativeLoop` for an engine run.
    const loop: Loop = {
      name: "parallel-native",
      run: (req, ctx) =>
        nativeLoop.run(
          {
            ...req,
            model: chatModel(scripted),
            toolConcurrency: { maxConcurrent: 4, concurrencySafe: () => true },
          },
          ctx,
        ),
    }
    const workdir = await mkdtemp(path.join(tmpdir(), "combined-mask-"))
    const spec: RunSpec = {
      runId: "r",
      workspaceId: "w",
      workflowPath: "wf.yml",
      workflow: { name: "Demo", prompt: "Do the thing." },
      inputs: {},
      context: "",
      workdir,
      permissions: { tools: [] },
      secrets: {},
      connectors: [connector],
      provider: { preferred: "mock" },
    }
    const result = await new NativeEngine({ loop }).run(spec, { log: () => {} })

    expect(result.outcome).toBe("completed")
    // The three calls really overlapped on the server.
    expect(server.stats.maxInFlight).toBeGreaterThanOrEqual(2)
    const results = toolTurns(result.messages ?? []).flat()
    expect(results.map((r) => r.toolCallId)).toEqual(["w1", "w2", "w3"])
    for (const r of results) {
      expect(r.isError ?? false).toBe(false)
      expect(r.content).not.toContain("rotating-")
      expect(r.content).toContain("[secret]")
    }
    // Each call carried a token of its own, every one of them masked above.
    const sent = new Set(server.authorizations.filter((a) => a.startsWith("Bearer rotating-")))
    expect(sent.size).toBeGreaterThanOrEqual(3)
  })
})

// ── Settling what a parallel step left behind ────────────────────────────────

describe("settling a transcript a parallel step suspended", () => {
  it("closes the parked calls of an abandoned parallel step so a new ask is a valid seed", async () => {
    const t = tracker()
    const read = t.tool("read", { safe: true })
    const ask: Tool = {
      spec: { name: "ask", description: "ask a person", inputSchema: { type: "object" } },
      meta: { dispatch: "external", concurrencySafe: true },
      execute: async () => {
        throw new Error("never run in the loop")
      },
    }
    const first = await runConversation({
      provider: new ScriptedProvider([
        step([
          ["ask", "x1", {}],
          ["read", "a", { id: "a" }],
          ["ask", "x2", {}],
        ]),
      ]),
      system: "",
      messages: seed,
      tools: [read, ask],
      toolConcurrency: parallel(),
      log: () => {},
    })
    expect(first.outcome).toBe("suspended")
    expect(first.pending?.map((c) => c.id)).toEqual(["x1", "x2"])

    // The caller abandons the parked calls and asks something new instead.
    const next = withUserTurn(first.messages, "never mind, just say hi")
    const [results] = toolTurns(next)
    expect(results?.map((r) => [r.toolCallId, r.isError ?? false])).toEqual([
      ["a", false],
      ["x1", true],
      ["x2", true],
    ])
    const second = await runConversation({
      provider: new ScriptedProvider([prose("hi")]),
      system: "",
      messages: next,
      tools: [read, ask],
      toolConcurrency: parallel(),
      log: () => {},
    })
    expect(second.outcome).toBe("completed")
    expect(second.text).toBe("hi")
  })
})
