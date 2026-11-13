import { describe, it, expect } from "vitest"
// The public entry point: `prepareMessages` and its type are part of the API.
import { NativeEngine, chatModel, nativeLoop, runConversation } from "./index.js"
import type {
  AgentMessage,
  ConverseRequest,
  ConverseResult,
  PrepareMessages,
  Provider,
  RunSpec,
  Tool,
} from "./index.js"

/** Asks for `lookup` on each of the first `calls` turns, then answers; records every request. */
class RecordingProvider implements Provider {
  readonly name = "recording"
  readonly sent: AgentMessage[][] = []
  private turns = 0
  constructor(private readonly calls = 2) {}
  async complete(): Promise<string> {
    return ""
  }
  async converse(req: ConverseRequest): Promise<ConverseResult> {
    this.sent.push(req.messages)
    this.turns += 1
    if (this.turns <= this.calls) {
      return {
        text: "",
        toolCalls: [{ id: `c${this.turns}`, name: "lookup", input: {} }],
      }
    }
    return { text: "done", toolCalls: [] }
  }
}

const lookup: Tool = {
  spec: { name: "lookup", description: "lookup", inputSchema: { type: "object" } },
  execute: async () => "a long result",
}

/** Squashes every tool result but the newest, keeping each call answered. */
const squashOld: PrepareMessages = (messages) => {
  const lastTool = messages.map((m) => m.role).lastIndexOf("tool")
  return messages.map((m, i) =>
    m.role === "tool" && i !== lastTool
      ? { role: "tool", results: m.results.map((r) => ({ ...r, content: "[squashed]" })) }
      : m,
  )
}

const seed: AgentMessage[] = [{ role: "user", text: "go" }]

const toolContents = (messages: AgentMessage[]): string[] =>
  messages.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []))

describe("prepareMessages", () => {
  it("shapes what each call is sent and leaves the returned transcript unprepared", async () => {
    const provider = new RecordingProvider()
    const result = await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [lookup],
      prepareMessages: squashOld,
    })

    expect(result.text).toBe("done")
    // The third call carries two tool turns; the older one went out squashed.
    expect(toolContents(provider.sent[2]!)).toEqual(["[squashed]", "a long result"])
    // The stored transcript is the unprepared history.
    expect(toolContents(result.messages)).toEqual(["a long result", "a long result"])
  })

  it("appends the budget line after the prepared messages, so a policy never sees it", async () => {
    const seen: AgentMessage[][] = []
    const provider = new RecordingProvider(1)
    await runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [lookup],
      budgetVisible: true,
      prepareMessages: (messages) => {
        seen.push([...messages])
        return [...messages]
      },
    })

    for (const messages of seen) {
      expect(messages.some((m) => m.role === "user" && m.text.startsWith("[budget]"))).toBe(false)
    }
    const last = provider.sent[1]!.at(-1)
    expect(last?.role === "user" && last.text.startsWith("[budget]")).toBe(true)
  })

  it("hands the policy a copy: mutating it cannot reach the transcript", async () => {
    const result = await runConversation({
      provider: new RecordingProvider(1),
      system: "s",
      messages: seed,
      tools: [lookup],
      prepareMessages: (messages) => {
        const out = messages as AgentMessage[]
        out.splice(0, 0, { role: "user", text: "injected" })
        return out
      },
    })

    expect(result.messages.some((m) => m.role === "user" && m.text === "injected")).toBe(false)
  })

  it.each<[string, PrepareMessages, RegExp]>([
    [
      "a tool call whose result was cut",
      (messages) => messages.filter((m) => m.role !== "tool"),
      /message 1 has tool calls with no result: c1/,
    ],
    [
      "a tool result whose call was cut",
      (messages) => messages.filter((m) => m.role !== "assistant"),
      /message 1 is a tool turn that answers no tool call/,
    ],
    [
      "a result answering a call twice",
      (messages) =>
        messages.map((m) =>
          m.role === "tool" ? { role: "tool", results: [...m.results, ...m.results] } : m,
        ),
      /message 2 has results that answer no call, or answer one twice: c1/,
    ],
    [
      "two tool calls sharing an id",
      (messages) =>
        messages.map((m) =>
          m.role === "assistant" && m.toolCalls.length > 0
            ? { ...m, toolCalls: [...m.toolCalls, ...m.toolCalls] }
            : m,
        ),
      /message 1 makes more than one tool call with the same id: c1/,
    ],
    ["nothing at all", () => [], /no messages/],
  ])("fails the run loudly on %s", async (_name, prepareMessages, why) => {
    const provider = new RecordingProvider(1)
    // The first call goes through (a lone user turn is fine); the second is malformed.
    const run = runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [lookup],
      prepareMessages: (messages) =>
        messages.length === 1 ? [...messages] : prepareMessages(messages),
    })
    await expect(run).rejects.toThrow(/^prepareMessages returned a malformed request: /)
    await expect(run).rejects.toThrow(why)
    // Nothing malformed reached the provider.
    expect(provider.sent).toHaveLength(1)
  })

  it.each<[string, PrepareMessages]>([
    ["returns a malformed request", (messages) => messages.filter((m) => m.role !== "tool")],
    [
      "throws",
      () => {
        throw new Error("policy broke")
      },
    ],
  ])("fails the run when the policy %s on the closing summary call", async (_name, broken) => {
    // One step, spent on a tool call: the summary is the policy's first chance to break.
    const provider = new RecordingProvider(5)
    const run = runConversation({
      provider,
      system: "s",
      messages: seed,
      tools: [lookup],
      maxSteps: 1,
      prepareMessages: (messages) => (messages.length === 1 ? [...messages] : broken(messages)),
    })
    await expect(run).rejects.toThrow(/prepareMessages returned a malformed request|policy broke/)
    expect(provider.sent).toHaveLength(1)
  })

  it("reaches a NativeEngine run through its loop option, since RunSpec carries no function", async () => {
    const provider = new RecordingProvider()
    const spec: RunSpec = {
      runId: "r",
      workspaceId: "ws",
      workflowPath: "wf.yml",
      workflow: { name: "Demo", prompt: "Do it." },
      inputs: {},
      context: "",
      workdir: "/tmp",
      permissions: { tools: [] },
      secrets: {},
      connectors: [],
      provider: { preferred: "mock" },
    }
    const engine = new NativeEngine({
      domainTools: () => [lookup],
      // The documented recipe: a loop that forwards to nativeLoop with the
      // policy set. It also swaps the engine's mock for the recording provider.
      loop: {
        name: "prepared",
        run: (req, ctx) =>
          nativeLoop.run({ ...req, model: chatModel(provider), prepareMessages: squashOld }, ctx),
      },
    })
    await engine.run(spec, { log: () => {} })

    expect(toolContents(provider.sent[2]!)).toEqual(["[squashed]", "a long result"])
  })
})
