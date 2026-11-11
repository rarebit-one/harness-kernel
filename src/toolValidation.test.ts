import { describe, it, expect } from "vitest"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runConversation } from "./agent.js"
import { NativeEngine } from "./engines/native.js"
import { recordRunEvents, type RunEvent } from "./events.js"
import { privateRunChannels } from "./private.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { ConverseResult } from "./providers/types.js"
import type { McpConnection } from "./connectors/mcpClient.js"
import type { Loop, LoopRequest } from "./loop.js"
import { connectorTools, type Tool } from "./tools/registry.js"
import { terminalTool } from "./tools/terminal.js"

const ran: Array<Record<string, unknown>> = []
const lookup: Tool = {
  spec: {
    name: "lookup",
    description: "look a record up",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, limit: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  execute: async (input) => {
    ran.push(input)
    return "found"
  },
}

const reply = terminalTool({
  name: "reply",
  description: "Send the final answer.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
})

const call = (name: string, input: Record<string, unknown>, id = "c1"): ConverseResult => ({
  text: "",
  toolCalls: [{ id, name, input }],
})
const prose = (text: string): ConverseResult => ({ text, toolCalls: [] })

const failures = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "tool.failed" ? [[e.callId, e.reason]] : []))
const called = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "tool.called" ? [e.callId] : []))

async function run(
  script: ConverseResult[],
  tools: Tool[],
  // The option is left out entirely, not passed as `false`, for the default case.
  options: { validateToolInput?: boolean } = { validateToolInput: true },
) {
  ran.length = 0
  const { sink, events } = recordRunEvents()
  const result = await runConversation({
    provider: new ScriptedProvider(script),
    system: "s",
    messages: [{ role: "user", text: "go" }],
    tools,
    emit: sink,
    ...options,
  })
  const toolTurn = result.messages[2]
  const first = toolTurn?.role === "tool" ? toolTurn.results[0] : undefined
  return { result, events, first }
}

describe("validateToolInput in the loop", () => {
  it("is off by default: a call that misses its schema still runs, as before", async () => {
    const { events, first } = await run(
      [call("lookup", { limit: "x" }), prose("done")],
      [lookup],
      {},
    )

    expect(ran).toEqual([{ limit: "x" }])
    expect(first).toMatchObject({ toolCallId: "c1", content: "found" })
    expect(failures(events)).toEqual([])
  })

  it("runs a call that fits", async () => {
    const { events, first } = await run(
      [call("lookup", { id: "a1", limit: 2 }), prose("done")],
      [lookup],
    )

    expect(ran).toEqual([{ id: "a1", limit: 2 }])
    expect(first?.isError).toBeUndefined()
    expect(called(events)).toEqual(["c1"])
  })

  it.each([
    ["a missing required property", { limit: 2 }, "/id: is required"],
    ["a wrong type", { id: 7 }, "/id: expected string, got number"],
    [
      "a property additionalProperties: false forbids",
      { id: "a1", extra: true },
      "/extra: is not an allowed property",
    ],
  ])("refuses %s without running it, and tells the model why", async (_, input, problem) => {
    const { result, events, first } = await run([call("lookup", input), prose("done")], [lookup])

    expect(ran).toEqual([])
    expect(first).toMatchObject({ toolCallId: "c1", isError: true })
    expect(first?.content).toContain("invalid arguments for lookup; the call was not run")
    expect(first?.content).toContain(problem)
    // Refused before execution: no `tool.called`, one `tool.failed` with the new reason.
    expect(called(events)).toEqual([])
    expect(failures(events)).toEqual([["c1", "invalid_input"]])
    const failed = events.find((e) => e.type === "tool.failed")
    expect(failed?.type === "tool.failed" && failed.error).toBe(first?.content)
    // The model answered again on its own; the loop made no extra call for it.
    expect(result.steps).toBe(2)
    expect(result.text).toBe("done")
  })

  it("does not end the run on an invalid terminal call, and takes the corrected one", async () => {
    const { result, events, first } = await run(
      [call("reply", { txt: "hi" }, "r1"), call("reply", { text: "hi" }, "r2")],
      [reply],
    )

    expect(first).toMatchObject({ toolCallId: "r1", isError: true })
    expect(first?.content).toContain("/text: is required")
    expect(result.stopReason).toBe("terminal_tool")
    expect(result.terminal).toMatchObject({ callId: "r2", input: { text: "hi" } })
    expect(failures(events)).toEqual([["r1", "invalid_input"]])
    expect(called(events)).toEqual(["r2"])
  })

  it("refuses an invalid external call instead of parking it", async () => {
    const ask: Tool = {
      ...lookup,
      spec: { ...lookup.spec, name: "ask" },
      meta: { dispatch: "external" },
    }
    const { result, events } = await run([call("ask", {}), prose("done")], [ask])

    expect(result.outcome).toBe("completed")
    expect(result.pending).toBeUndefined()
    expect(events.some((e) => e.type === "tool.pending")).toBe(false)
    expect(failures(events)).toEqual([["c1", "invalid_input"]])
  })

  it("checks MCP connector tools against the schema their server listed", async () => {
    const sent: unknown[] = []
    const conn: McpConnection = {
      listTools: async () => ({
        tools: [
          {
            name: "search",
            description: "find things",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" }, since: { type: "string", format: "date" } },
              required: ["q"],
            },
          },
        ],
      }),
      callTool: async (name, args) => {
        sent.push(args)
        return { content: [{ type: "text", text: `${name} ok` }] }
      },
      close: async () => {},
    }
    const { tools, close } = await connectorTools(
      [{ name: "docs", kind: "mcp", transport: "streamable_http", endpoint: "https://x" }],
      async () => conn,
    )

    try {
      const { events } = await run(
        [
          call("docs__search", { query: "x" }, "m1"),
          // `format` is outside the checked subset, so the server decides it.
          call("docs__search", { q: "x", since: "last week" }, "m2"),
          prose("done"),
        ],
        tools,
      )

      expect(sent).toEqual([{ q: "x", since: "last week" }])
      expect(failures(events)).toEqual([["m1", "invalid_input"]])
      expect(called(events)).toEqual(["m2"])
    } finally {
      await close()
    }
  })

  it("does not fail the run when a tool's schema trips the validator", async () => {
    const odd: Tool = {
      ...lookup,
      spec: {
        ...lookup.spec,
        inputSchema: {
          type: "object",
          properties: { id: { $ref: "#/$defs/100%" } },
          $defs: { "100%": { type: "string" } },
        },
      },
    }
    const { result, first } = await run([call("lookup", { id: "a1" }), prose("done")], [odd])

    expect(result.outcome).toBe("completed")
    expect(first).toMatchObject({ toolCallId: "c1", content: "found" })
  })

  it("keeps the invalid_input reason through a private run's redaction", async () => {
    const { sink, events } = recordRunEvents()
    const channels = privateRunChannels(() => {}, sink)
    await runConversation({
      provider: new ScriptedProvider([call("lookup", {}), prose("done")]),
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [lookup],
      validateToolInput: true,
      log: channels.log,
      emit: channels.emit,
    })

    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({
      reason: "invalid_input",
      redacted: true,
    })
  })

  it("reaches the loop from RunSpec on the native engine", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "native-validate-"))
    let seen: LoopRequest | undefined
    const loop: Loop = {
      name: "records",
      run: async (req) => {
        seen = req
        return { text: "", steps: 0, outcome: "completed" }
      },
    }
    const base = {
      runId: "r",
      workspaceId: "w",
      workflowPath: "wf.yml",
      workflow: { prompt: "Do the thing." },
      inputs: {},
      context: "",
      workdir,
      permissions: { tools: [] },
      secrets: {},
      connectors: [],
      provider: { preferred: "mock" },
    }

    await new NativeEngine({ loop }).run(base, { log: () => {} })
    expect(seen?.validateToolInput).toBeUndefined()
    await new NativeEngine({ loop }).run({ ...base, validateToolInput: true }, { log: () => {} })
    expect(seen?.validateToolInput).toBe(true)
  })
})
