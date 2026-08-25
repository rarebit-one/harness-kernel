import { describe, it, expect, vi, afterEach } from "vitest"
import { LocalProvider, LOCAL_DEFAULT_MODEL } from "./local.js"

// Capture the OpenAI SDK constructor options and chat.completions.create()
// request bodies without touching the network — the local provider's endpoint,
// auth handling, and model live in the constructor options.
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

describe("local client configuration", () => {
  it("points the OpenAI SDK at the supplied base URL and is named local", () => {
    const provider = new LocalProvider("http://127.0.0.1:8080/v1", "sk-local")

    expect(provider.name).toBe("local")
    expect(ctorMock.mock.calls[0]![0]).toMatchObject({
      apiKey: "sk-local",
      baseURL: "http://127.0.0.1:8080/v1",
    })
    // A supplied key is sent normally — no header suppression.
    expect(ctorMock.mock.calls[0]![0]).not.toHaveProperty("defaultHeaders")
  })

  it("omits the Authorization header entirely when no key is given", () => {
    new LocalProvider("http://127.0.0.1:8080/v1")

    const opts = ctorMock.mock.calls[0]![0] as {
      apiKey: string
      defaultHeaders: Record<string, string | null>
    }
    // A placeholder satisfies the SDK constructor, but the header is dropped so a
    // keyless server never receives `Bearer no-key`.
    expect(opts.apiKey).toBe("no-key")
    expect(opts.defaultHeaders).toEqual({ Authorization: null })
  })

  it("treats an empty-string key as no key", () => {
    new LocalProvider("http://127.0.0.1:8080/v1", "")

    expect(ctorMock.mock.calls[0]![0]).toMatchObject({ defaultHeaders: { Authorization: null } })
  })

  it("resolves the model: explicit, then LOCAL_MODEL, then the coded default", async () => {
    const explicit = new LocalProvider("http://x/v1", undefined, "my-gguf")
    await explicit.complete({ system: "s", prompt: "hi" })
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "my-gguf" })
    createMock.mockClear()

    vi.stubEnv("LOCAL_MODEL", "env-model")
    await new LocalProvider("http://x/v1").complete({ system: "s", prompt: "hi" })
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "env-model" })
    createMock.mockClear()

    vi.stubEnv("LOCAL_MODEL", undefined)
    await new LocalProvider("http://x/v1").complete({ system: "s", prompt: "hi" })
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: LOCAL_DEFAULT_MODEL })
  })
})

describe("local converse (shared OpenAI-compatible core)", () => {
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

    const result = await new LocalProvider("http://x/v1").converse({
      system: "sys",
      messages: [{ role: "user", text: "list files" }],
      tools: [{ name: "run_code", description: "run", inputSchema: { type: "object" } }],
    })

    expect(createMock.mock.calls[0]![0]).toMatchObject({
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
})
