import { describe, it, expect } from "vitest"
import { TruncatedAnswerError, isTruncatedCall, runAgent, runConversation } from "./agent.js"
import { recordRunEvents } from "./events.js"
import { ScriptedProvider } from "./providers/scripted.js"
import type { AgentMessage, ConverseResult, Provider } from "./providers/types.js"
import { terminalTool } from "./tools/terminal.js"
import type { Tool } from "./tools/registry.js"

const echo: Tool = {
  spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
  execute: async (input) => `echoed ${JSON.stringify(input)}`,
}

const reply = terminalTool({
  name: "reply",
  description: "Send the final answer to the user.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
})

const callEcho = (id = "c1"): ConverseResult => ({
  text: "",
  toolCalls: [{ id, name: "echo", input: { v: 1 } }],
})
const callReply = (text: string, id = "r1"): ConverseResult => ({
  text: "",
  toolCalls: [{ id, name: "reply", input: { text } }],
})
const prose = (text: string): ConverseResult => ({ text, toolCalls: [] })

describe("runConversation", () => {
  it("continues a seeded conversation and returns the whole transcript without mutating the seed", async () => {
    const seed: AgentMessage[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi, what now?", toolCalls: [] },
      { role: "user", text: "echo something" },
    ]
    const provider = new ScriptedProvider([callEcho(), prose("done")])

    const result = await runConversation({ provider, system: "s", messages: seed, tools: [echo] })

    expect(result.text).toBe("done")
    expect(result.stopReason).toBe("end_turn")
    expect(result.outcome).toBe("completed")
    expect(result.provider).toBe("scripted")
    expect(result.steps).toBe(2)
    // Seed + assistant (tool call) + tool result + assistant (final).
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
    expect(result.messages.slice(0, 3)).toEqual(seed)
    expect(seed).toHaveLength(3)
    // The first model call saw exactly the seed; the second saw the tool round trip.
    expect(provider.requests[0]?.messages).toEqual(seed)
    expect(provider.requests[1]?.messages).toHaveLength(5)
    expect(provider.remaining).toBe(0)
  })

  it("stops on a terminal tool with the call as the structured answer", async () => {
    const provider = new ScriptedProvider([callReply("42")])
    const { sink, events } = recordRunEvents()

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "the answer?" }],
      tools: [echo, reply],
      emit: sink,
    })

    expect(result.stopReason).toBe("terminal_tool")
    expect(result.outcome).toBe("completed")
    expect(result.terminal).toEqual({
      callId: "r1",
      name: "reply",
      input: { text: "42" },
      output: { content: "accepted" },
    })
    // No prose placeholder: the answer is structured, and the turn said nothing.
    expect(result.text).toBe("")
    // The transcript carries the tool result, so it can be resumed next turn.
    const last = result.messages[result.messages.length - 1]
    expect(last).toEqual({
      role: "tool",
      results: [{ toolCallId: "r1", content: "accepted" }],
    })
    expect(events[events.length - 1]).toMatchObject({
      type: "run.finished",
      outcome: "completed",
      stopReason: "terminal_tool",
    })
    expect(provider.remaining).toBe(0)
  })

  it("treats a terminal tool that throws as an ordinary tool error and lets the model retry", async () => {
    const strict: Tool = {
      spec: reply.spec,
      meta: { dispatch: "terminal" },
      execute: async (input) => {
        if (String(input.text).length > 3) throw new Error("too long")
        return "sent"
      },
    }
    const provider = new ScriptedProvider([callReply("toolong", "r1"), callReply("ok", "r2")])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [strict],
    })

    expect(result.stopReason).toBe("terminal_tool")
    expect(result.terminal).toMatchObject({ callId: "r2", input: { text: "ok" } })
    expect(result.steps).toBe(2)
    // The failed attempt is in the transcript as an error result the model saw.
    const firstResult = result.messages[2]
    expect(firstResult).toEqual({
      role: "tool",
      results: [{ toolCallId: "r1", content: "too long", isError: true }],
    })
  })

  it("runs the other calls of a terminal turn too, so the transcript stays whole", async () => {
    const provider = new ScriptedProvider([
      {
        text: "here you go",
        toolCalls: [
          { id: "c1", name: "echo", input: { v: 1 } },
          { id: "r1", name: "reply", input: { text: "both" } },
        ],
      },
    ])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo, reply],
    })

    expect(result.terminal?.callId).toBe("r1")
    expect(result.text).toBe("here you go")
    const toolMessage = result.messages[2]
    expect(toolMessage?.role === "tool" && toolMessage.results.map((r) => r.toolCallId)).toEqual([
      "c1",
      "r1",
    ])
  })

  it("reports the stop, not the answer, when a terminal tool ignores its signal", async () => {
    const controller = new AbortController()
    const ignoring: Tool = {
      spec: reply.spec,
      meta: { dispatch: "terminal" },
      // Cancels the run mid-execution and returns anyway, like a tool that
      // never looked at its signal.
      execute: async () => {
        controller.abort("user left")
        return "sent anyway"
      },
    }
    const provider = new ScriptedProvider([callReply("late")])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [ignoring],
      signal: controller.signal,
    })

    expect(result.outcome).toBe("canceled")
    expect(result.stopReason).toBe("canceled")
    expect(result.terminal).toBeUndefined()
    // The transcript still carries the result, so nothing dangles.
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "tool",
      results: [{ toolCallId: "r1", content: "sent anyway" }],
    })
    expect(result.events[result.events.length - 1]).toMatchObject({
      type: "run.finished",
      outcome: "canceled",
      stopReason: "canceled",
    })
  })

  it("closes the turn when a stop lands partway through its tool calls", async () => {
    const controller = new AbortController()
    const ran: string[] = []
    const aborting: Tool = {
      spec: { name: "first", description: "first", inputSchema: { type: "object" } },
      execute: async () => {
        ran.push("first")
        controller.abort("user left")
        return "first done"
      },
    }
    const never: Tool = {
      spec: { name: "second", description: "second", inputSchema: { type: "object" } },
      execute: async () => {
        ran.push("second")
        return "second done"
      },
    }
    const provider = new ScriptedProvider([
      {
        text: "",
        toolCalls: [
          { id: "a", name: "first", input: {} },
          { id: "b", name: "second", input: {} },
        ],
      },
    ])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [aborting, never],
      signal: controller.signal,
    })

    expect(result.outcome).toBe("canceled")
    // The second tool never started: a cancel must prevent exactly that.
    expect(ran).toEqual(["first"])
    // But every call the model made is answered, so the transcript resumes.
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "tool",
      results: [
        { toolCallId: "a", content: "first done" },
        {
          toolCallId: "b",
          content: "not run: the run was stopped before this tool call",
          isError: true,
        },
      ],
    })
  })

  it("answers every call of a turn that arrived after the stop", async () => {
    const controller = new AbortController()
    // A provider that never looks at its signal: it cancels mid-call and still
    // returns a turn asking for a tool. (ScriptedProvider honours the signal,
    // so it cannot play this part.)
    const provider: Provider = {
      name: "deaf",
      complete: async () => "",
      converse: async () => {
        controller.abort("deadline")
        return { text: "", toolCalls: [{ id: "a", name: "echo", input: {} }] }
      },
    }

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
      signal: controller.signal,
    })

    expect(result.outcome).toBe("canceled")
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    const last = result.messages[2]
    expect(last?.role === "tool" && last.results[0]).toMatchObject({
      toolCallId: "a",
      isError: true,
    })
  })

  it("counts an answer on the last allowed step as completed, not steps_exhausted", async () => {
    const provider = new ScriptedProvider([callReply("last")])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [reply],
      maxSteps: 1,
    })

    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("terminal_tool")
    // No summary call was spent.
    expect(provider.requests).toHaveLength(1)
  })

  it("refuses an external tool before any model call", async () => {
    const pending: Tool = {
      spec: {
        name: "ask_device",
        description: "runs on the client",
        inputSchema: { type: "object" },
      },
      meta: { dispatch: "external" },
      execute: async () => "never",
    }
    const provider = new ScriptedProvider([prose("unreachable")])
    const { sink, events } = recordRunEvents()

    await expect(
      runConversation({
        provider,
        system: "s",
        messages: [{ role: "user", text: "go" }],
        tools: [pending],
        emit: sink,
      }),
    ).rejects.toThrow(/ask_device.*external/)

    expect(provider.requests).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"])
    expect(events[1]).toMatchObject({ outcome: "failed" })
  })

  it("rejects a seed the model could not continue", async () => {
    const provider = new ScriptedProvider([prose("unreachable")])
    await expect(
      runConversation({ provider, system: "s", messages: [], tools: [] }),
    ).rejects.toThrow(/empty/)
    await expect(
      runConversation({
        provider,
        system: "s",
        messages: [{ role: "assistant", text: "dangling", toolCalls: [] }],
        tools: [],
      }),
    ).rejects.toThrow(/assistant message/)
    expect(provider.requests).toHaveLength(0)
  })

  it("accepts a seed that ends with tool results, the resume shape", async () => {
    const provider = new ScriptedProvider([prose("thanks for the result")])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "", toolCalls: [{ id: "x", name: "echo", input: {} }] },
        { role: "tool", results: [{ toolCallId: "x", content: "supplied by the caller" }] },
      ],
      tools: [echo],
    })
    expect(result.text).toBe("thanks for the result")
    expect(result.messages).toHaveLength(4)
  })

  it("sums usage across every model call, the budget summary included", async () => {
    const provider = new ScriptedProvider(
      [
        {
          ...callEcho(),
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cacheReadTokens: 4,
            reportedCost: { amount: 0.002, currency: "USD" },
          },
          responseId: "gen-1",
        },
        {
          ...prose("summary"),
          usage: {
            inputTokens: 20,
            outputTokens: 2,
            totalTokens: 22,
            reasoningTokens: 1,
            reportedCost: { amount: 0.003, currency: "USD" },
          },
          responseId: "gen-2",
        },
      ],
      { reportsUsage: true },
    )

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
      maxSteps: 1, // the second turn is the tools-free summary call
    })

    expect(result.outcome).toBe("steps_exhausted")
    expect(result.stopReason).toBe("steps_exhausted")
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      cacheReadTokens: 4,
      reasoningTokens: 1,
      reportedCost: { amount: 0.005, currency: "USD" },
    })
    expect(result.responseIds).toEqual(["gen-1", "gen-2"])
    expect(
      result.events
        .filter((e) => e.type === "model.turn")
        .map((e) => e.type === "model.turn" && e.responseId),
    ).toEqual(["gen-1", "gen-2"])
    // The summary is part of the transcript a caller stores.
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "assistant",
      text: "summary",
      toolCalls: [],
    })
  })

  it("leaves usage absent when no call reported any", async () => {
    const result = await runConversation({
      provider: new ScriptedProvider([prose("ok")]),
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [],
    })
    expect(result.usage).toBeUndefined()
    expect(result.responseIds).toEqual([])
  })

  it("reports the model the response named, else the provider's configured model", async () => {
    const provider = new ScriptedProvider(
      [callEcho(), { ...prose("done"), model: "m-served", upstream: "Vendor X" }],
      { model: "m-config" },
    )
    const { sink, events } = recordRunEvents()

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
      emit: sink,
    })

    expect(result.model).toBe("m-served")
    expect(result.upstream).toBe("Vendor X")
    const upstreams = events.map((e) => (e.type === "model.turn" ? e.upstream : "-"))
    expect(upstreams.filter((u) => u !== "-")).toEqual([undefined, "Vendor X"])
    const turns = events.filter((e) => e.type === "model.turn")
    expect(turns.map((t) => t.type === "model.turn" && t.model)).toEqual(["m-config", "m-served"])
  })

  it("keeps the transcript and the terminal answer as the model said them when a tool mutates its input", async () => {
    const mutating: Tool = {
      spec: reply.spec,
      meta: { dispatch: "terminal" },
      execute: async (input) => {
        input.text = "MUTATED"
        return "sent"
      },
    }
    const provider = new ScriptedProvider([callReply("original")])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [mutating],
    })
    expect(result.terminal?.input).toEqual({ text: "original" })
    const assistant = result.messages[1]
    expect(assistant?.role === "assistant" && assistant.toolCalls[0]?.input).toEqual({
      text: "original",
    })
  })

  it("reports the model and upstream of the LAST response only, clearing stale ones", async () => {
    const deaf: Provider = {
      name: "custom",
      complete: async () => "",
      converse: async (req) =>
        req.messages.length === 1
          ? { ...callEcho(), model: "m-first", upstream: "Vendor A" }
          : prose("done"), // the final turn names neither
    }
    const result = await runConversation({
      provider: deaf,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
    })
    expect(result.model).toBeUndefined()
    expect(result.upstream).toBeUndefined()
  })

  it("reports the upstream of the LAST response only, clearing a stale one", async () => {
    const provider = new ScriptedProvider([
      { ...callEcho(), upstream: "Vendor A" },
      prose("done"), // no upstream on the final turn
    ])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
    })
    expect(result.upstream).toBeUndefined()
  })

  it("sends providerOptions on every model call, the summary included", async () => {
    const provider = new ScriptedProvider([callEcho(), prose("summary")])
    const providerOptions = { maxTokens: 77, promptCache: { ttl: "1h" as const } }

    await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
      maxSteps: 1,
      providerOptions,
    })

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests.map((r) => r.providerOptions)).toEqual([
      providerOptions,
      providerOptions,
    ])
    expect(provider.requests[1]?.tools).toEqual([])
  })

  it("records the same events it delivered to emit, in order", async () => {
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider: new ScriptedProvider([callEcho(), prose("done")]),
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
      emit: sink,
    })
    expect(result.events).toEqual(events)
    expect(result.events.map((e) => e.type)).toEqual([
      "run.started",
      "model.turn",
      "tool.called",
      "tool.succeeded",
      "model.turn",
      "run.finished",
    ])
    expect(result.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("keeps recording when the caller's sink throws", async () => {
    const result = await runConversation({
      provider: new ScriptedProvider([prose("done")]),
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [],
      emit: () => {
        throw new Error("sink down")
      },
    })
    expect(result.text).toBe("done")
    expect(result.events.map((e) => e.type)).toEqual(["run.started", "model.turn", "run.finished"])
  })
})

describe("runAgent", () => {
  it("is runConversation with a one-message seed", async () => {
    const viaAgent = await runAgent({
      provider: new ScriptedProvider([callEcho(), prose("done")]),
      system: "s",
      userPrompt: "go",
      tools: [echo],
    })
    const viaConversation = await runConversation({
      provider: new ScriptedProvider([callEcho(), prose("done")]),
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
    })
    expect(viaAgent).toBe(viaConversation.text)
  })
})

describe("finish reasons and the length rule (0.11.0-next.1)", () => {
  const lengthTurn = (toolCalls: ConverseResult["toolCalls"], text = ""): ConverseResult => ({
    text,
    toolCalls,
    finishReason: "length",
  })

  it("refuses a terminal call on a length-truncated turn, even one that parsed, and lets the model answer again", async () => {
    const provider = new ScriptedProvider([
      lengthTurn([{ id: "r1", name: "reply", input: { text: "cut mid-sent" } }]),
      { ...callReply("whole", "r2"), finishReason: "tool_calls" },
    ])
    const { sink, events } = recordRunEvents()

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [reply],
      emit: sink,
    })

    expect(result.stopReason).toBe("terminal_tool")
    expect(result.terminal?.callId).toBe("r2")
    expect(result.finishReason).toBe("tool_calls")
    // The refused call never ran, was answered as an error, and is in the stream as truncated.
    const refused = result.messages[2]
    expect(refused?.role === "tool" && refused.results[0]).toMatchObject({
      toolCallId: "r1",
      isError: true,
    })
    expect(refused?.role === "tool" && refused.results[0]?.content).toMatch(/cut off/)
    expect(
      events
        .filter((e) => e.type === "tool.failed")
        .map((e) => e.type === "tool.failed" && e.reason),
    ).toEqual(["truncated"])
    // Only the accepted retry ran; the refused call never reached `tool.called`.
    expect(
      events
        .filter((e) => e.type === "tool.called")
        .map((e) => e.type === "tool.called" && e.callId),
    ).toEqual(["r2"])
    expect(
      events
        .filter((e) => e.type === "model.turn")
        .map((e) => e.type === "model.turn" && e.finishReason),
    ).toEqual(["length", "tool_calls"])
  })

  it("refuses a call whose raw arguments do not parse, on any turn, and runs one that did", async () => {
    const ran: unknown[] = []
    const probe: Tool = {
      spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: async (input) => {
        ran.push(input)
        return "ok"
      },
    }
    const provider = new ScriptedProvider([
      {
        text: "",
        toolCalls: [
          { id: "c1", name: "echo", input: {}, argumentsText: '{"v": 1, "w": [' },
          { id: "c2", name: "echo", input: { v: 2 }, argumentsText: '{"v": 2}' },
        ],
        finishReason: "length",
      },
      prose("done"),
    ])

    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [probe],
    })

    expect(ran).toEqual([{ v: 2 }])
    const toolMsg = result.messages[2]
    expect(toolMsg?.role === "tool" && toolMsg.results.map((r) => r.isError ?? false)).toEqual([
      true,
      false,
    ])
    expect(result.stopReason).toBe("end_turn")
  })

  it("refuses a call with no raw arguments on a length turn (Anthropic shape) and runs it on a whole turn", async () => {
    const ran: string[] = []
    const probe: Tool = {
      spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: async () => {
        ran.push("ran")
        return "ok"
      },
    }
    // No argumentsText at all: the dialect handed over an object, so nothing
    // proves the call was whole when the turn was cut.
    const bare = { id: "c1", name: "echo", input: { v: 1 } }
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [bare], finishReason: "length" },
      { text: "", toolCalls: [{ ...bare, id: "c2" }], finishReason: "tool_calls" },
      prose("done"),
    ])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [probe],
    })
    expect(ran).toEqual(["ran"])
    const first = result.messages[2]
    expect(first?.role === "tool" && first.results[0]?.isError).toBe(true)
  })

  it("keeps runAgent resolving on a cancel, even when the last turn before the stop was cut", async () => {
    const controller = new AbortController()
    // Ignores its signal: cancels mid-call and still returns a cut-off turn.
    const deaf: Provider = {
      name: "deaf",
      complete: async () => "",
      converse: async () => {
        controller.abort("user left")
        return { text: "once upon a ti", toolCalls: [], finishReason: "length" }
      },
    }
    const text = await runAgent({
      provider: deaf,
      system: "s",
      userPrompt: "go",
      tools: [],
      signal: controller.signal,
    })
    expect(text).toContain("[run stopped: canceled")
  })

  it("makes runAgent throw when the budget summary itself was cut off", async () => {
    const provider = new ScriptedProvider([
      callEcho(),
      { ...prose("the summary was cut at the ca"), finishReason: "length" },
    ])
    const run = () =>
      runAgent({ provider, system: "s", userPrompt: "go", tools: [echo], maxSteps: 1 })
    const err = await run().then(
      () => {
        throw new Error("expected runAgent to throw")
      },
      (e: unknown) => e as TruncatedAnswerError,
    )
    expect(err).toBeInstanceOf(TruncatedAnswerError)
    expect(err.result.stopReason).toBe("steps_exhausted")
    expect(err.result.finishReason).toBe("length")
  })

  it("refuses a call with empty arguments on a length turn and runs it on a whole turn", async () => {
    const ran: string[] = []
    const probe: Tool = {
      spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: async () => {
        ran.push("ran")
        return "ok"
      },
    }
    const emptyCall = { id: "c1", name: "echo", input: {}, argumentsText: "" }
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [emptyCall], finishReason: "length" },
      { text: "", toolCalls: [{ ...emptyCall, id: "c2" }], finishReason: "tool_calls" },
      prose("done"),
    ])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [probe],
    })
    expect(ran).toEqual(["ran"])
    const first = result.messages[2]
    const second = result.messages[4]
    expect(first?.role === "tool" && first.results[0]?.isError).toBe(true)
    expect(second?.role === "tool" && second.results[0]?.isError).toBeUndefined()
  })

  it("makes runAgent throw on a cut-off answer, since a bare string cannot say so", async () => {
    const run = () =>
      runAgent({
        provider: new ScriptedProvider([lengthTurn([], "once upon a ti")]),
        system: "s",
        userPrompt: "tell me a story",
        tools: [],
      })
    await expect(run()).rejects.toBeInstanceOf(TruncatedAnswerError)
    await expect(run()).rejects.toThrow(/runConversation/)
    const err = await run().then(
      () => {
        throw new Error("expected runAgent to throw")
      },
      (e: unknown) => e as TruncatedAnswerError,
    )
    // The partial text and the whole run are still reachable from the error.
    expect(err.text).toBe("once upon a ti")
    expect(err.result.stopReason).toBe("length")
    // A whole answer is unaffected.
    await expect(
      runAgent({
        provider: new ScriptedProvider([{ ...prose("whole"), finishReason: "stop" }]),
        system: "s",
        userPrompt: "go",
        tools: [],
      }),
    ).resolves.toBe("whole")
  })

  it("marks a cut-off prose answer with stopReason length while the run still completes", async () => {
    const { sink, events } = recordRunEvents()
    const result = await runConversation({
      provider: new ScriptedProvider([lengthTurn([], "once upon a ti")]),
      system: "s",
      messages: [{ role: "user", text: "tell me a story" }],
      tools: [],
      emit: sink,
    })
    expect(result.outcome).toBe("completed")
    expect(result.stopReason).toBe("length")
    expect(result.finishReason).toBe("length")
    expect(result.text).toBe("once upon a ti")
    expect(events[events.length - 1]).toMatchObject({ type: "run.finished", stopReason: "length" })
  })

  it("still ends steps_exhausted when every attempt is truncated", async () => {
    const provider = new ScriptedProvider([
      lengthTurn([{ id: "r1", name: "reply", input: { text: "a" } }]),
      lengthTurn([{ id: "r2", name: "reply", input: { text: "b" } }]),
      { ...prose("summary"), finishReason: "stop" },
    ])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [reply],
      maxSteps: 2,
    })
    expect(result.stopReason).toBe("steps_exhausted")
    expect(result.terminal).toBeUndefined()
    expect(result.text).toBe("summary")
  })

  it("carries argumentsText and meta through the transcript untouched", async () => {
    const provider = new ScriptedProvider([
      {
        text: "",
        toolCalls: [
          { id: "c1", name: "echo", input: { v: 1 }, argumentsText: '{"v":1}', meta: { sig: "s" } },
        ],
      },
      prose("done"),
    ])
    const result = await runConversation({
      provider,
      system: "s",
      messages: [{ role: "user", text: "go" }],
      tools: [echo],
    })
    const assistant = result.messages[1]
    expect(assistant?.role === "assistant" && assistant.toolCalls[0]).toMatchObject({
      argumentsText: '{"v":1}',
      meta: { sig: "s" },
    })
    // The second model call saw them too.
    const replayed = provider.requests[1]?.messages[1]
    expect(replayed?.role === "assistant" && replayed.toolCalls[0]?.meta).toEqual({ sig: "s" })
  })

  it("judges truncation from the raw text, and from the finish reason for empty text", () => {
    const call = (argumentsText?: string) => ({
      id: "x",
      name: "n",
      input: {},
      ...(argumentsText !== undefined ? { argumentsText } : {}),
    })
    expect(isTruncatedCall(call())).toBe(false)
    // Empty text is a zero-argument call on a whole turn and a cut-off on a `length` turn.
    expect(isTruncatedCall(call(""))).toBe(false)
    expect(isTruncatedCall(call("  "), "stop")).toBe(false)
    expect(isTruncatedCall(call(""), "length")).toBe(true)
    expect(isTruncatedCall(call("  "), "length")).toBe(true)
    expect(isTruncatedCall(call("{}"))).toBe(false)
    expect(isTruncatedCall(call("{}"), "length")).toBe(false)
    expect(isTruncatedCall(call('{"a":1}'))).toBe(false)
    expect(isTruncatedCall(call('{"a":'))).toBe(true)
    expect(isTruncatedCall(call("[1,2]"))).toBe(true)
    expect(isTruncatedCall(call("42"))).toBe(true)
  })
})
