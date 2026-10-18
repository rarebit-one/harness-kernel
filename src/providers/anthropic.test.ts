import { describe, it, expect, vi, afterEach } from "vitest"
import {
  AnthropicProvider,
  anthropicRequestBody,
  toAnthropicMessages,
  parseAnthropicContent,
} from "./anthropic.js"
import { ProviderOptionsError } from "./options.js"
import type { AgentMessage, ConverseRequest } from "./types.js"

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

describe("anthropic provider options", () => {
  const conversation: AgentMessage[] = [
    { role: "user", text: "first" },
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "echo", input: {} }] },
    { role: "tool", results: [{ toolCallId: "t1", content: "r" }] },
    { role: "user", text: "last" },
  ]
  const tools = [
    { name: "a", description: "a", inputSchema: { type: "object" } },
    { name: "b", description: "b", inputSchema: { type: "object" } },
  ]
  const request = (overrides: Partial<ConverseRequest> = {}): ConverseRequest => ({
    system: "sys",
    messages: conversation,
    tools,
    ...overrides,
  })
  const ephemeral = { type: "ephemeral" }

  it("sends no cache_control at all unless asked", () => {
    const body = anthropicRequestBody("m", request(), 100)
    expect(body.system).toBe("sys")
    expect(JSON.stringify(body)).not.toContain("cache_control")
    expect(body.max_tokens).toBe(100)
  })

  it("places breakpoints on the system prompt, the last tool and the last message", () => {
    const body = anthropicRequestBody("m", request({ providerOptions: { promptCache: {} } }), 100)

    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: ephemeral }])
    expect(body.tools?.[0]).not.toHaveProperty("cache_control")
    expect(body.tools?.[1]).toMatchObject({ name: "b", cache_control: ephemeral })
    // Only the trailing message is marked, and it becomes a block to carry it.
    expect(body.messages[0]).toEqual({ role: "user", content: "first" })
    expect(body.messages[3]).toEqual({
      role: "user",
      content: [{ type: "text", text: "last", cache_control: ephemeral }],
    })
    expect(JSON.stringify(body.messages.slice(0, 3))).not.toContain("cache_control")
  })

  it("marks the last block of each trailing message, whatever its role, and clamps to two", () => {
    const body = anthropicRequestBody(
      "m",
      request({ providerOptions: { promptCache: { trailingMessages: 5, ttl: "1h" } } }),
      100,
    )
    const ttl = { type: "ephemeral", ttl: "1h" }
    // Two, not five: Anthropic allows four breakpoints and two are spent above.
    expect(JSON.stringify(body.messages[1])).not.toContain("cache_control")
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "r",
          is_error: false,
          cache_control: ttl,
        },
      ],
    })
    expect(body.messages[3]).toEqual({
      role: "user",
      content: [{ type: "text", text: "last", cache_control: ttl }],
    })
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: ttl }])
    expect(body.tools?.[1]).toMatchObject({ cache_control: ttl })
  })

  it("marks an assistant turn's last block when it is in the window", () => {
    const mapped = toAnthropicMessages(conversation.slice(0, 2), { trailingMessages: 1 })
    expect(mapped[1]?.content).toEqual([
      { type: "tool_use", id: "t1", name: "echo", input: {}, cache_control: ephemeral },
    ])
  })

  it("honours system/tools opt-outs and keeps an empty system prompt a string", () => {
    const body = anthropicRequestBody(
      "m",
      request({
        system: "",
        providerOptions: { promptCache: { tools: false, trailingMessages: 0 } },
      }),
      100,
    )
    expect(body.system).toBe("")
    expect(JSON.stringify(body.tools)).not.toContain("cache_control")
    expect(JSON.stringify(body.messages)).not.toContain("cache_control")
  })

  it("lets a per-call maxTokens override the env cap", () => {
    expect(
      anthropicRequestBody("m", request({ providerOptions: { maxTokens: 12 } }), 100).max_tokens,
    ).toBe(12)
    expect(
      anthropicRequestBody("m", request({ providerOptions: { maxTokens: 0 } }), 100).max_tokens,
    ).toBe(100)
  })

  it("rejects options it cannot honour instead of dropping them", () => {
    expect(() =>
      anthropicRequestBody(
        "m",
        request({ providerOptions: { responseFormat: { type: "json_object" } } }),
      ),
    ).toThrow(ProviderOptionsError)
    expect(() =>
      anthropicRequestBody("m", request({ providerOptions: { openrouter: { models: ["x"] } } })),
    ).toThrow(/providerOptions\.openrouter/)
  })

  it("reports the model the response named", async () => {
    createMock.mockResolvedValueOnce({
      id: "msg_01",
      content: [{ type: "text", text: "hi", citations: [] }],
      model: "claude-served-1",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never)
    const result = await new AnthropicProvider("k", "claude-requested").converse(
      request({ providerOptions: { maxRetries: 0 } }),
    )
    expect(result.model).toBe("claude-served-1")
    expect(result.responseId).toBe("msg_01")
    expect((createMock.mock.calls[0] as unknown[])[1]).toEqual({ maxRetries: 0 })
    expect(new AnthropicProvider("k", "claude-requested").model).toBe("claude-requested")
  })
})
