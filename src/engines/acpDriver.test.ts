import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { MessageTooLargeError } from "@agentclientprotocol/sdk"
import type { AcpOptions } from "./acp.js"
import { defaultAcpDriver } from "./acpDriver.js"

/**
 * A minimal ACP agent over stdio, run as `node -e`: answers `initialize` and
 * `session/new`, then hands `session/prompt` to `onPrompt`, which can write
 * notifications and requests with `send` and settle the turn with `reply`.
 */
function fakeAgent(onPrompt: string): string {
  return `
    const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n")
    let promptId
    const reply = (result) => send({ id: promptId, result })
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const msg = JSON.parse(line)
      if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } })
      else if (msg.method === "session/prompt") { promptId = msg.id; ${onPrompt} }
      else if (msg.id === "perm") send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission " + JSON.stringify(msg.result.outcome) } } } }), reply({ stopReason: "end_turn" })
    })
  `
}

function options(agent: string, overrides: Partial<AcpOptions> = {}): AcpOptions {
  return {
    command: process.execPath,
    args: ["-e", agent],
    env: {},
    cwd: tmpdir(),
    mcpServers: [],
    prompt: "go",
    log: () => {},
    ...overrides,
  }
}

describe("defaultAcpDriver over stdio", () => {
  it("runs a turn: message chunks reach the run, thoughts and tool titles reach the log", async () => {
    const agent = fakeAgent(`
      const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } })
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read file" })
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } })
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } })
      setTimeout(() => reply({ stopReason: "end_turn" }), 20)
    `)
    const chunks: string[] = []
    const logs: string[] = []
    const outcome = await defaultAcpDriver(options(agent), {
      onAssistantChunk: (text) => chunks.push(text),
      onLog: (line) => logs.push(line),
    })
    expect(outcome).toEqual({ stopReason: "end_turn" })
    expect(chunks.join("")).toBe("hello world")
    expect(logs).toEqual(["thought: hmm", "tool: read file"])
  }, 8_000)

  it("auto-approves a permission request with an allow option", async () => {
    const agent = fakeAgent(`
      send({ id: "perm", method: "session/request_permission", params: {
        sessionId: "s1",
        toolCall: { toolCallId: "t1", title: "write" },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      } })
    `)
    const chunks: string[] = []
    const outcome = await defaultAcpDriver(options(agent), {
      onAssistantChunk: (text) => chunks.push(text),
      onLog: () => {},
    })
    expect(outcome).toEqual({ stopReason: "end_turn" })
    expect(chunks.join("")).toBe(`permission {"outcome":"selected","optionId":"yes"}`)
  }, 8_000)

  it("fails the run with a clear error when the agent sends a message over the size cap", async () => {
    // One line past the SDK's default 32 MiB cap, never terminated: unbounded,
    // it would be buffered until the host ran out of memory.
    const agent = fakeAgent(`process.stdout.write("x".repeat(32 * 1024 * 1024 + 1))`)
    const run = defaultAcpDriver(options(agent), { onAssistantChunk: () => {}, onLog: () => {} })
    await expect(run).rejects.toThrow(/agent sent an ACP message over the 33554432-byte limit/)
    await expect(run).rejects.toHaveProperty("cause", expect.any(MessageTooLargeError))
  }, 15_000)
})
