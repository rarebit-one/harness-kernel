import { describe, it, expect, vi, afterEach } from "vitest"
import {
  OpenAICompatibleProvider,
  OpenAIProvider,
  openAICompatibleRequestBody,
  openAIUsage,
  toOpenAIMessages,
  parseOpenAIMessage,
} from "./openai.js"
import { ProviderOptionsError } from "./options.js"
import type { AgentMessage, ConverseRequest } from "./types.js"

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

  it("sends the configured RUNNER_MAX_TOKENS as max_completion_tokens on converse", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "2222")
    const provider = new OpenAIProvider("test-key")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_completion_tokens: 2222 })
  })

  it("sends the configured RUNNER_MAX_TOKENS as max_completion_tokens on complete", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "2222")
    const provider = new OpenAIProvider("test-key")

    await provider.complete({ system: "s", prompt: "hi" })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_completion_tokens: 2222 })
  })

  it("defaults the cap to 4096 when RUNNER_MAX_TOKENS is unset", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", undefined)
    const provider = new OpenAIProvider("test-key")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_completion_tokens: 4096 })
  })
})

describe("openai provider options", () => {
  const request = (overrides: Partial<ConverseRequest> = {}): ConverseRequest => ({
    system: "sys",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    ...overrides,
  })

  it("maps promptCache.key onto prompt_cache_key and places no breakpoints (caching is automatic)", () => {
    const body = openAICompatibleRequestBody(
      "openai",
      "gpt",
      request({ providerOptions: { promptCache: { key: "tenant-7" } } }),
      100,
    )
    expect(body.prompt_cache_key).toBe("tenant-7")
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ])
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("passes response_format through and lets maxTokens override the env cap", () => {
    const body = openAICompatibleRequestBody(
      "openai",
      "gpt",
      request({ providerOptions: { responseFormat: { type: "json_object" }, maxTokens: 33 } }),
      100,
    )
    expect(body.response_format).toEqual({ type: "json_object" })
    // OpenAI's current field; its reasoning models reject `max_tokens`.
    expect(body.max_completion_tokens).toBe(33)
    expect(body).not.toHaveProperty("max_tokens")
    // The other dialects keep the field they document.
    expect(openAICompatibleRequestBody("openrouter", "m", request(), 100).max_tokens).toBe(100)
    expect(openAICompatibleRequestBody("local", "m", request(), 100).max_tokens).toBe(100)
  })

  it("carries cost, cache writes and reasoning tokens when the usage block has them", () => {
    expect(
      openAIUsage({
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 15 },
        cost: 0.0071,
      } as never),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 60,
      cacheWriteTokens: 20,
      reasoningTokens: 15,
      reportedCost: { amount: 0.0071, currency: "USD" },
    })
    // Absent means unknown, never zero.
    expect(openAIUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
  })

  it("passes a per-call maxRetries to the SDK request, leaving the client alone", async () => {
    await new OpenAIProvider("k").converse(request({ providerOptions: { maxRetries: 0 } }))
    expect((createMock.mock.calls[0] as unknown[])[1]).toEqual({ maxRetries: 0 })
    createMock.mockClear()
    await new OpenAIProvider("k").converse(request())
    expect((createMock.mock.calls[0] as unknown[])[1]).toEqual({})
  })

  it("rejects the OpenRouter block on openai and on a local/custom endpoint", () => {
    const withBlock = request({ providerOptions: { openrouter: { models: ["a/b"] } } })
    expect(() => openAICompatibleRequestBody("openai", "gpt", withBlock, 100)).toThrow(
      ProviderOptionsError,
    )
    expect(() => openAICompatibleRequestBody("local", "m", withBlock, 100)).toThrow(
      /provider "local" does not support providerOptions\.openrouter/,
    )
  })

  it("reports the model the response named and exposes the configured one", async () => {
    createMock.mockResolvedValueOnce({
      id: "chatcmpl-1",
      model: "gpt-served",
      choices: [{ message: { role: "assistant", content: "ok", refusal: null } }],
    } as never)
    const provider = new OpenAIProvider("k", "gpt-requested")
    const result = await provider.converse(request())
    expect(result.model).toBe("gpt-served")
    expect(result.responseId).toBe("chatcmpl-1")
    expect(result.upstream).toBeUndefined()
    expect(provider.model).toBe("gpt-requested")
    expect(new OpenAICompatibleProvider("custom", { apiKey: "k", model: "m" }).model).toBe("m")
  })
})
