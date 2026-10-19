import { describe, it, expect, vi, afterEach } from "vitest"
import { OpenRouterProvider, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL } from "./openrouter.js"

// Capture the OpenAI SDK constructor options and chat.completions.create()
// request bodies without touching the network. OpenRouter reuses the SDK, so
// its endpoint/headers live in the constructor options.
const { createMock, ctorMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_body: Record<string, unknown>) => ({ choices: [] })),
  ctorMock: vi.fn(),
}))
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } }
    constructor(opts: Record<string, unknown>) {
      ctorMock(opts)
    }
  },
}))

afterEach(() => {
  vi.unstubAllEnvs()
  createMock.mockClear()
  ctorMock.mockClear()
})

describe("openrouter client configuration", () => {
  it("points the OpenAI SDK at openrouter.ai and sends no attribution by default", () => {
    new OpenRouterProvider("or-key")

    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(ctorMock.mock.calls[0]![0]).toMatchObject({
      apiKey: "or-key",
      baseURL: OPENROUTER_BASE_URL,
    })
    // The kernel has no app identity of its own — it must not attribute runs to
    // anyone the embedding application didn't name.
    expect(ctorMock.mock.calls[0]![0]).not.toHaveProperty("defaultHeaders")
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1")
  })

  it("sends only the attribution headers the caller supplied", () => {
    new OpenRouterProvider("or-key", undefined, { title: "Acme" })

    expect(ctorMock.mock.calls[0]![0]).toMatchObject({
      defaultHeaders: { "X-Title": "Acme" },
    })
    expect(
      (ctorMock.mock.calls[0]![0] as { defaultHeaders: Record<string, string> }).defaultHeaders,
    ).not.toHaveProperty("HTTP-Referer")
  })

  it("sends both attribution headers when both are given", () => {
    new OpenRouterProvider("or-key", undefined, {
      referer: "https://acme.example",
      title: "Acme",
    })

    expect(ctorMock.mock.calls[0]![0]).toMatchObject({
      defaultHeaders: { "HTTP-Referer": "https://acme.example", "X-Title": "Acme" },
    })
  })

  it("passes namespaced model ids through untouched", async () => {
    const provider = new OpenRouterProvider("or-key", "openai/gpt-4.1")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "openai/gpt-4.1" })
  })

  it("falls back to OPENROUTER_MODEL, then the coded default", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "anthropic/claude-opus-4.5")
    await new OpenRouterProvider("or-key").complete({ system: "s", prompt: "hi" })
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "anthropic/claude-opus-4.5" })

    vi.stubEnv("OPENROUTER_MODEL", undefined)
    createMock.mockClear()
    await new OpenRouterProvider("or-key").complete({ system: "s", prompt: "hi" })
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: OPENROUTER_DEFAULT_MODEL })
  })

  it("is named openrouter", () => {
    expect(new OpenRouterProvider("or-key").name).toBe("openrouter")
  })
})

describe("openrouter converse (shared OpenAI-compatible core)", () => {
  it("sends tools and parses tool calls from the response", async () => {
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: "on it",
            refusal: null,
            tool_calls: [
              {
                id: "t1",
                type: "function",
                function: { name: "run_code", arguments: '{"command":"ls"}' },
              },
            ],
          },
        },
      ],
    } as never)
    const provider = new OpenRouterProvider("or-key")

    const result = await provider.converse({
      system: "sys",
      messages: [{ role: "user", text: "list files" }],
      tools: [{ name: "run_code", description: "run", inputSchema: { type: "object" } }],
    })

    expect(createMock.mock.calls[0]![0]).toMatchObject({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "list files" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "run_code", description: "run", parameters: { type: "object" } },
        },
      ],
    })
    expect(result.text).toBe("on it")
    expect(result.toolCalls).toEqual([{ id: "t1", name: "run_code", input: { command: "ls" } }])
  })

  it("surfaces a refusal as text like the OpenAI provider", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: null, refusal: "nope" } }],
    } as never)
    const provider = new OpenRouterProvider("or-key")

    const result = await provider.converse({
      system: "s",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    })

    expect(result).toEqual({ text: "Refused: nope", toolCalls: [] })
  })

  it("sends the configured RUNNER_MAX_TOKENS as max_tokens", async () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "2222")
    const provider = new OpenRouterProvider("or-key")

    await provider.converse({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] })

    expect(createMock.mock.calls[0]![0]).toMatchObject({ max_tokens: 2222 })
  })
})

describe("openrouter provider options", () => {
  const conversation = [
    { role: "user" as const, text: "first" },
    { role: "assistant" as const, text: "", toolCalls: [{ id: "t1", name: "echo", input: {} }] },
    { role: "tool" as const, results: [{ toolCallId: "t1", content: "r" }] },
    { role: "user" as const, text: "last" },
  ]

  it("sends models, provider routing, usage and transforms in the body", async () => {
    const provider = new OpenRouterProvider("or-key", "anthropic/claude-sonnet-4.5")
    await provider.converse({
      system: "s",
      messages: conversation,
      tools: [],
      providerOptions: {
        maxTokens: 512,
        responseFormat: { type: "json_object" },
        openrouter: {
          models: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
          provider: { data_collection: "deny", zdr: true, order: ["Anthropic"] },
          usage: { include: true },
          transforms: ["middle-out"],
        },
      },
    })

    expect(createMock.mock.calls[0]![0]).toMatchObject({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 512,
      response_format: { type: "json_object" },
      models: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
      provider: { data_collection: "deny", zdr: true, order: ["Anthropic"] },
      usage: { include: true },
      transforms: ["middle-out"],
    })
  })

  it("places cache_control as content parts on the system prompt and the trailing messages", async () => {
    const provider = new OpenRouterProvider("or-key")
    await provider.converse({
      system: "sys",
      messages: conversation,
      tools: [],
      providerOptions: { promptCache: { trailingMessages: 2, ttl: "1h" } },
    })

    const body = createMock.mock.calls[0]![0] as { messages: unknown[] }
    const cc = { type: "ephemeral", ttl: "1h" }
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "sys", cache_control: cc }],
    })
    expect(body.messages[1]).toEqual({ role: "user", content: "first" })
    // The assistant turn with no prose has nowhere to put a breakpoint and is left alone.
    expect(JSON.stringify(body.messages[2])).not.toContain("cache_control")
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: [{ type: "text", text: "r", cache_control: cc }],
    })
    expect(body.messages[4]).toEqual({
      role: "user",
      content: [{ type: "text", text: "last", cache_control: cc }],
    })
    // No prompt_cache_key: that is OpenAI's mechanism, not OpenRouter's.
    expect(body).not.toHaveProperty("prompt_cache_key")
  })

  it("reports the served model and the upstream that served it", async () => {
    createMock.mockResolvedValueOnce({
      id: "gen-abc",
      model: "anthropic/claude-sonnet-4.5",
      provider: "Anthropic",
      choices: [{ message: { role: "assistant", content: "ok", refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    } as never)
    const result = await new OpenRouterProvider("or-key").converse({
      system: "s",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    })
    expect(result.model).toBe("anthropic/claude-sonnet-4.5")
    expect(result.upstream).toBe("Anthropic")
    expect(result.responseId).toBe("gen-abc")
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  })
})
