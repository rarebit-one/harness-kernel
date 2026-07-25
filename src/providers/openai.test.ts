import { describe, it, expect, vi, afterEach } from "vitest"
import { OpenAIProvider, toOpenAIMessages, parseOpenAIMessage } from "./openai.js"
import type { AgentMessage } from "./types.js"

// Capture chat.completions.create() request bodies without touching the network.
const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_body: Record<string, unknown>) => ({ choices: [] })),
}))
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } }
  },
}))

describe("openai message mapping", () => {
  it("maps user, assistant tool_calls, and tool-result turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "calling",
        toolCalls: [{ id: "t1", name: "read_file", input: { path: "a" } }],
      },
      {
        role: "tool",
        results: [
          { toolCallId: "t1", content: "data" },
          { toolCallId: "t2", content: "more" },
        ],
      },
    ]

    const mapped = toOpenAIMessages(messages)

    expect(mapped[0]).toEqual({ role: "user", content: "hi" })
    expect(mapped[1]).toEqual({
      role: "assistant",
      content: "calling",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
      ],
    })
    // One `tool` message per result.
    expect(mapped[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "data" })
    expect(mapped[3]).toEqual({ role: "tool", tool_call_id: "t2", content: "more" })
  })

  it("omits tool_calls on an assistant turn with no calls", () => {
    const mapped = toOpenAIMessages([{ role: "assistant", text: "done", toolCalls: [] }])
    expect(mapped[0]).toEqual({ role: "assistant", content: "done" })
  })

  it("parses text and tool_calls from a response message", () => {
    const result = parseOpenAIMessage({
      role: "assistant",
      content: "hello",
      refusal: null,
      tool_calls: [
        {
          id: "x",
          type: "function",
          function: { name: "run_code", arguments: '{"command":"ls"}' },
        },
      ],
    } as never)

    expect(result.text).toBe("hello")
    expect(result.toolCalls).toEqual([{ id: "x", name: "run_code", input: { command: "ls" } }])
  })

  it("treats null content as empty text", () => {
    const result = parseOpenAIMessage({ role: "assistant", content: null, refusal: null } as never)
    expect(result).toEqual({ text: "", toolCalls: [] })
  })

  it("tolerates empty or invalid tool-call arguments", () => {
    const result = parseOpenAIMessage({
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "noop", arguments: "" } },
        { id: "b", type: "function", function: { name: "bad", arguments: "{not json" } },
      ],
    } as never)

    expect(result.toolCalls).toEqual([
      { id: "a", name: "noop", input: {} },
      { id: "b", name: "bad", input: {} },
    ])
  })
})

describe("openai request limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    createMock.mockClear()
  })

  it("sends the configured RUNNER_MAX_TOKENS as max_tokens on converse", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "2222")
    const provider = new OpenAIProvider("test-key")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 2222 })
  })

  it("sends the configured RUNNER_MAX_TOKENS as max_tokens on complete", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "2222")
    const provider = new OpenAIProvider("test-key")

    await provider.complete({ system: "s", prompt: "hi" })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 2222 })
  })

  it("defaults max_tokens to 4096 when RUNNER_MAX_TOKENS is unset", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", undefined)
    const provider = new OpenAIProvider("test-key")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 4096 })
  })
})
