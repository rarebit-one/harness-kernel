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
  it("points the OpenAI SDK at openrouter.ai with the attribution headers", () => {
    new OpenRouterProvider("or-key")

    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(ctorMock.mock.calls[0]![0]).toMatchObject({
      apiKey: "or-key",
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://jumpdrive.app",
        "X-Title": "Jumpdrive",
      },
    })
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1")
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
