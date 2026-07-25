import { describe, it, expect, vi, afterEach } from "vitest"
import { maxToolResultBytes, runAgent } from "./agent.js"
import type { ConverseRequest, ConverseResult, Provider } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"

// A provider that calls one tool on the first turn, then finishes — exercising
// the full request → tool → result → request loop without a real model.
class ScriptedProvider implements Provider {
  readonly name = "scripted"
  private turns = 0

  async complete(): Promise<string> {
    return ""
  }

  async converse(req: ConverseRequest): Promise<ConverseResult> {
    this.turns += 1
    if (this.turns === 1) {
      return { text: "", toolCalls: [{ id: "t1", name: "echo", input: { v: "hi" } }] }
    }
    const last = req.messages[req.messages.length - 1]!
    return { text: `done: ${JSON.stringify(last)}`, toolCalls: [] }
  }
}

describe("runAgent", () => {
  const echoTool: Tool = {
    spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
    execute: async (input) => `echoed ${JSON.stringify(input)}`,
  }

  it("runs a requested tool and feeds the result back before finishing", async () => {
    const out = await runAgent({
      provider: new ScriptedProvider(),
      system: "s",
      userPrompt: "go",
      tools: [echoTool],
    })

    expect(out).toContain("done:")
    expect(out).toContain("echoed")
  })

  it("surfaces unknown tools as errors without crashing", async () => {
    class BadToolProvider implements Provider {
      readonly name = "bad"
      private turns = 0
      async complete(): Promise<string> {
        return ""
      }
      async converse(req: ConverseRequest): Promise<ConverseResult> {
        this.turns += 1
        if (this.turns === 1) {
          return { text: "", toolCalls: [{ id: "t1", name: "missing", input: {} }] }
        }
        const last = req.messages[req.messages.length - 1]!
        return { text: JSON.stringify(last), toolCalls: [] }
      }
    }

    const out = await runAgent({
      provider: new BadToolProvider(),
      system: "s",
      userPrompt: "go",
      tools: [echoTool],
    })

    expect(out).toContain("unknown tool: missing")
  })

  it("recovers a final summary when the step budget is exhausted", async () => {
    // Always wants a tool while tools are offered; returns prose only when asked
    // with no tools (the post-budget summary call).
    class AlwaysToolProvider implements Provider {
      readonly name = "always"
      async complete(): Promise<string> {
        return ""
      }
      async converse(req: ConverseRequest): Promise<ConverseResult> {
        if (req.tools.length === 0) return { text: "summary", toolCalls: [] }
        return { text: "thinking", toolCalls: [{ id: "t", name: "echo", input: {} }] }
      }
    }

    const out = await runAgent({
      provider: new AlwaysToolProvider(),
      system: "s",
      userPrompt: "go",
      tools: [echoTool],
      maxSteps: 2,
    })

    expect(out).toBe("summary")
  })

  it("stops cleanly and notes the budget when the wall-clock time is exceeded", async () => {
    // First turn yields prose + a tool call and consumes the whole (tiny) budget;
    // the deadline check before the second turn then trips, so we return the
    // accumulated prose with a clear note rather than throwing or summarizing.
    class SlowProvider implements Provider {
      readonly name = "slow"
      private turns = 0
      async complete(): Promise<string> {
        return ""
      }
      async converse(): Promise<ConverseResult> {
        this.turns += 1
        // Burn past the 10ms budget on the first turn so the next loop iteration
        // sees the deadline as passed.
        await new Promise((r) => setTimeout(r, 20))
        return {
          text: `partial progress ${this.turns}`,
          toolCalls: [{ id: "t", name: "echo", input: {} }],
        }
      }
    }

    const out = await runAgent({
      provider: new SlowProvider(),
      system: "s",
      userPrompt: "go",
      tools: [echoTool],
      maxSteps: 10,
      maxDurationMs: 10,
    })

    expect(out).toContain("partial progress")
    expect(out).toContain("wall-clock budget")
  })

  it("truncates tool output at the env-configured RUNNER_MAX_TOOL_RESULT_BYTES", async () => {
    vi.stubEnv("RUNNER_MAX_TOOL_RESULT_BYTES", "16")
    try {
      const bigTool: Tool = {
        spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
        execute: async () => "x".repeat(100),
      }

      const out = await runAgent({
        provider: new ScriptedProvider(),
        system: "s",
        userPrompt: "go",
        tools: [bigTool],
      })

      // The scripted provider echoes back the tool-result turn it received.
      expect(out).toContain("truncated 84 bytes")
      expect(out).not.toContain("x".repeat(17))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("maxToolResultBytes", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("falls back to 64 KiB when RUNNER_MAX_TOOL_RESULT_BYTES is unset", () => {
    vi.stubEnv("RUNNER_MAX_TOOL_RESULT_BYTES", undefined)
    expect(maxToolResultBytes()).toBe(64 * 1024)
  })

  it("uses a configured positive integer", () => {
    vi.stubEnv("RUNNER_MAX_TOOL_RESULT_BYTES", "1024")
    expect(maxToolResultBytes()).toBe(1024)
  })

  it.each(["garbage", "", "0", "-1", "Infinity"])(
    "falls back to 64 KiB for invalid value %j",
    (raw) => {
      vi.stubEnv("RUNNER_MAX_TOOL_RESULT_BYTES", raw)
      expect(maxToolResultBytes()).toBe(64 * 1024)
    },
  )
})
