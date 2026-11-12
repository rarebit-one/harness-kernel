import { describe, it, expect } from "vitest"
import { runConversation, withToolResults } from "./agent.js"
import { recordRunEvents } from "./events.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult, ToolCall } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"
import { settleMessages, withUserTurn } from "./transcript.js"

const askHuman: Tool = {
  spec: { name: "ask_human", description: "ask a person", inputSchema: { type: "object" } },
  meta: { dispatch: "external" },
  execute: async () => {
    throw new Error("an external tool's executor must never run in the loop")
  },
}
const echo: Tool = {
  spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
  execute: async (input) => `echoed ${JSON.stringify(input)}`,
}

const prose = (text: string): ConverseResult => ({ text, toolCalls: [] })
const toolCall = (name: string, id: string): ToolCall => ({
  id,
  name,
  input: {},
  argumentsText: "{}",
})
const calling = (...calls: ToolCall[]): ConverseResult => ({ text: "", toolCalls: calls })
const notRun = (id: string) => ({
  toolCallId: id,
  content: "not run: the turn ended before this tool call was answered",
  isError: true,
})

/**
 * Hand `seed` to the loop and let it answer once. The loop's own seed check
 * runs before the first model call, so a seed it would refuse throws here.
 */
async function seedsTheLoop(seed: AgentMessage[]): Promise<void> {
  const provider = new ScriptedProvider([prose("ok")])
  const result = await runConversation({ provider, system: "s", messages: seed, tools: [echo] })
  expect(result.outcome).toBe("completed")
  // What the model was sent is the seed, unchanged.
  expect(provider.requests[0]?.messages).toEqual(seed)
}

const finished: AgentMessage[] = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1")] },
  { role: "tool", results: [{ toolCallId: "e1", content: "echoed {}" }] },
  { role: "assistant", text: "hello", toolCalls: [] },
]

describe("settleMessages", () => {
  it("leaves a finished transcript as it is", async () => {
    expect(settleMessages(finished)).toEqual(finished)
    await seedsTheLoop(withUserTurn(finished, "again"))
  })

  it("answers a single trailing unanswered call with a neutral error result", async () => {
    const cut: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "checking", toolCalls: [toolCall("echo", "e1")] },
    ]
    expect(settleMessages(cut)).toEqual([...cut, { role: "tool", results: [notRun("e1")] }])
    await seedsTheLoop(settleMessages(cut))
    await seedsTheLoop(withUserTurn(cut, "never mind"))
  })

  it("answers several trailing unanswered calls in one tool turn", () => {
    const cut: AgentMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [toolCall("echo", "e1"), toolCall("echo", "e2"), toolCall("echo", "e3")],
      },
    ]
    expect(settleMessages(cut).at(-1)).toEqual({
      role: "tool",
      results: [notRun("e1"), notRun("e2"), notRun("e3")],
    })
  })

  it("completes a tool turn that answers only some of its calls", async () => {
    // A suspended mixed step: the server-side call ran, the parked one did not.
    const partial: AgentMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [toolCall("echo", "e1"), { ...toolCall("ask_human", "h1"), external: true }],
      },
      { role: "tool", results: [{ toolCallId: "e1", content: "echoed {}" }] },
    ]
    const settled = settleMessages(partial)
    expect(settled).toHaveLength(3)
    expect(settled.at(-1)).toEqual({
      role: "tool",
      results: [{ toolCallId: "e1", content: "echoed {}" }, notRun("h1")],
    })
    await seedsTheLoop(settled)
  })

  it("repairs a call left unanswered in the middle of the transcript", async () => {
    // A user turn appended straight after a suspended turn, without settling.
    const damaged: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1")] },
      { role: "user", text: "are you there?" },
    ]
    expect(settleMessages(damaged)).toEqual([
      damaged[0],
      damaged[1],
      { role: "tool", results: [notRun("e1")] },
      damaged[2],
    ])
    await seedsTheLoop(settleMessages(damaged))
  })

  it("keeps a turn the output cap cut off, and answers its unparsed call", async () => {
    const truncated: ToolCall = { id: "e1", name: "echo", input: {}, argumentsText: '{"a":' }
    const cut: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "let me", toolCalls: [truncated] },
    ]
    const settled = settleMessages(cut)
    // The model's words are kept as it left them, raw bytes included.
    expect(settled[1]).toBe(cut[1])
    expect(settled.at(-1)).toEqual({ role: "tool", results: [notRun("e1")] })
    await seedsTheLoop(withUserTurn(cut, "go on"))
  })

  it("answers with the caller's result when one is given", () => {
    const parked: AgentMessage[] = [
      { role: "user", text: "may I?" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ ...toolCall("ask_human", "h1"), external: true }],
      },
    ]
    const settled = settleMessages(parked, {
      // `toolCallId` is the helper's to set, whatever the callback returns.
      answer: (call) => ({
        toolCallId: "wrong",
        content: `declined ${call.name}`,
        isError: true,
        rejected: true,
      }),
    })
    expect(settled.at(-1)).toEqual({
      role: "tool",
      results: [{ toolCallId: "h1", content: "declined ask_human", isError: true, rejected: true }],
    })
  })

  it("is idempotent", () => {
    const cut: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1"), toolCall("echo", "e2")] },
      { role: "tool", results: [{ toolCallId: "e2", content: "echoed {}" }] },
      { role: "user", text: "still there?" },
      { role: "assistant", text: "", toolCalls: [toolCall("echo", "e3")] },
    ]
    const once = settleMessages(cut)
    expect(settleMessages(once)).toEqual(once)
    const seed = withUserTurn(cut, "next")
    expect(settleMessages(seed)).toEqual(seed)
  })

  it("mutates neither the array nor its messages", () => {
    const cut: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1"), toolCall("echo", "e2")] },
      { role: "tool", results: [{ toolCallId: "e1", content: "echoed {}" }] },
    ]
    const before = structuredClone(cut)
    const settled = withUserTurn(cut, "next")
    expect(cut).toEqual(before)
    expect(settled).not.toBe(cut)
  })

  it("throws on a tool turn that does not follow an assistant turn", () => {
    expect(() =>
      settleMessages([
        { role: "user", text: "hi" },
        { role: "tool", results: [{ toolCallId: "x", content: "?" }] },
      ]),
    ).toThrow(/does not follow an assistant turn/)
  })

  it("throws on a result for a call the assistant turn never made", () => {
    expect(() =>
      settleMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1")] },
        {
          role: "tool",
          results: [
            { toolCallId: "e1", content: "ok" },
            { toolCallId: "zz", content: "?" },
          ],
        },
      ]),
    ).toThrow(/never made: zz/)
  })
})

describe("settleMessages on what the loop never writes", () => {
  it("throws on two results for one call", () => {
    expect(() =>
      settleMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [toolCall("echo", "e1")] },
        {
          role: "tool",
          results: [
            { toolCallId: "e1", content: "ok" },
            { toolCallId: "e1", content: "again" },
          ],
        },
      ]),
    ).toThrow(/answers call id\(s\) more than once: e1/)
  })

  it("throws when the caller settles before answering", () => {
    // The wrong order: the parked call gets its placeholder, then its real
    // result. The loop's seed check would let that through; a provider would not.
    const parked: AgentMessage[] = [
      { role: "user", text: "may I?" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ ...toolCall("ask_human", "h1"), external: true }],
      },
    ]
    const wrongOrder = withToolResults(settleMessages(parked), [
      { toolCallId: "h1", content: "yes" },
    ])
    expect(() => settleMessages(wrongOrder)).toThrow(/more than once: h1/)
    expect(() => withUserTurn(wrongOrder, "next")).toThrow(/more than once: h1/)
  })

  it("throws on two calls with one id in an assistant turn", () => {
    expect(() =>
      settleMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [toolCall("echo", "x"), toolCall("echo", "x")] },
      ]),
    ).toThrow(/more than one tool call with the same id: x/)
  })

  it("throws on one assistant turn's results split across two tool turns", () => {
    expect(() =>
      settleMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [toolCall("echo", "a"), toolCall("echo", "b")] },
        { role: "tool", results: [{ toolCallId: "a", content: "ok" }] },
        { role: "tool", results: [{ toolCallId: "b", content: "ok" }] },
        { role: "user", text: "next" },
      ]),
    ).toThrow(/does not follow an assistant turn/)
  })

  it("orders a completed tool turn by call, not by which results were given", () => {
    const settled = settleMessages([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [toolCall("echo", "a"), toolCall("echo", "b"), toolCall("echo", "c")],
      },
      { role: "tool", results: [{ toolCallId: "c", content: "ok" }] },
    ])
    expect(settled.at(-1)).toEqual({
      role: "tool",
      results: [notRun("a"), notRun("b"), { toolCallId: "c", content: "ok" }],
    })
  })

  it("fills an empty tool turn", async () => {
    const settled = settleMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [toolCall("echo", "a")] },
      { role: "tool", results: [] },
    ])
    expect(settled.at(-1)).toEqual({ role: "tool", results: [notRun("a")] })
    expect(settleMessages(settled)).toEqual(settled)
    await seedsTheLoop(settled)
  })
})

describe("withUserTurn", () => {
  it("appends a user turn given as text", async () => {
    const seed = withUserTurn(finished, "and then?")
    expect(seed).toEqual([...finished, { role: "user", text: "and then?" }])
    await seedsTheLoop(seed)
  })

  it("appends a user turn given as an object", async () => {
    const seed = withUserTurn(finished, { text: "and then?" })
    expect(seed.at(-1)).toEqual({ role: "user", text: "and then?" })
    await seedsTheLoop(seed)
  })

  it("seeds an empty transcript with just the user turn", async () => {
    const seed = withUserTurn([], "first")
    expect(seed).toEqual([{ role: "user", text: "first" }])
    await seedsTheLoop(seed)
  })

  it("continues a suspended run the caller abandoned", async () => {
    // Run one parks a call; the caller never answers it, and the user moves on.
    const parked = await runConversation({
      provider: new ScriptedProvider([calling(toolCall("ask_human", "h1"))]),
      system: "s",
      messages: [{ role: "user", text: "may I?" }],
      tools: [askHuman],
    })
    expect(parked.outcome).toBe("suspended")

    const provider = new ScriptedProvider([prose("sure, what next?")])
    const next = await runConversation({
      provider,
      system: "s",
      messages: withUserTurn(parked.messages, "forget that"),
      tools: [askHuman],
    })
    expect(next.outcome).toBe("completed")
    expect(next.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ])
  })

  it("composes with withToolResults for a caller who answered some parked calls", async () => {
    const parked = await runConversation({
      provider: new ScriptedProvider([
        calling(toolCall("ask_human", "h1"), toolCall("ask_human", "h2")),
      ]),
      system: "s",
      messages: [{ role: "user", text: "may I?" }],
      tools: [askHuman],
    })
    expect(parked.pending).toHaveLength(2)

    // One answered, the other left for settle to close: as a resume seed, the
    // tail tool turn answers both, and the resumed run closes both parked calls.
    const seed = settleMessages(
      withToolResults(parked.messages, [{ toolCallId: "h1", content: "yes" }]),
    )
    const { sink, events } = recordRunEvents()
    const resumed = await runConversation({
      provider: new ScriptedProvider([prose("done")]),
      system: "s",
      messages: seed,
      tools: [askHuman],
      emit: sink,
    })
    expect(resumed.outcome).toBe("completed")
    expect(
      events
        .filter((e) => e.type === "tool.succeeded" || e.type === "tool.failed")
        .map((e) => [e.type, "callId" in e ? e.callId : undefined]),
    ).toEqual([
      ["tool.succeeded", "h1"],
      ["tool.failed", "h2"],
    ])
  })
})
