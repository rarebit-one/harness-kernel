import { describe, it, expect, vi, afterEach } from "vitest"
import { AnthropicProvider, toAnthropicMessages, parseAnthropicContent } from "./anthropic.js"
import type { AgentMessage } from "./types.js"

// Capture messages.create() request bodies without touching the network.
const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_body: Record<string, unknown>) => ({ content: [] })),
}))
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock }
  },
}))

describe("anthropic message mapping", () => {
  it("maps user, assistant tool_use, and tool-result turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "calling",
        toolCalls: [{ id: "t1", name: "read_file", input: { path: "a" } }],
      },
      { role: "tool", results: [{ toolCallId: "t1", content: "data" }] },
    ]

    const mapped = toAnthropicMessages(messages)

    expect(mapped[0]).toEqual({ role: "user", content: "hi" })
    expect(mapped[1]!.role).toBe("assistant")
    const assistantBlocks = mapped[1]!.content as unknown as Array<Record<string, unknown>>
    expect(assistantBlocks).toContainEqual({ type: "text", text: "calling" })
    expect(assistantBlocks).toContainEqual({
      type: "tool_use",
      id: "t1",
      name: "read_file",
      input: { path: "a" },
    })
    const toolBlocks = mapped[2]!.content as unknown as Array<Record<string, unknown>>
    expect(toolBlocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "data" })
  })

  it("parses text and tool_use blocks from a response", () => {
    const result = parseAnthropicContent([
      { type: "text", text: "hello", citations: [] },
      { type: "tool_use", id: "x", name: "run_code", input: { command: "ls" } },
    ] as never)

    expect(result.text).toBe("hello")
    expect(result.toolCalls).toEqual([{ id: "x", name: "run_code", input: { command: "ls" } }])
  })
})

describe("anthropic request limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    createMock.mockClear()
  })

  it("sends the configured RUNNER_MAX_TOKENS as max_tokens", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "1234")
    const provider = new AnthropicProvider("test-key")

    await provider.complete({ system: "s", prompt: "p" })
    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 1234 })
    expect(createMock.mock.calls[1]![0]).toMatchObject({ max_tokens: 1234 })
  })

  it("defaults max_tokens to 4096 when RUNNER_MAX_TOKENS is unset", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", undefined)
    const provider = new AnthropicProvider("test-key")

    await provider.complete({ system: "s", prompt: "p" })

    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 4096 })
  })
})
