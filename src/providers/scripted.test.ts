import { describe, it, expect } from "vitest"
import { ScriptExhaustedError, ScriptedProvider } from "./scripted.js"
import type { ConverseRequest } from "./types.js"

const req = (text: string): ConverseRequest => ({
  system: "s",
  messages: [{ role: "user", text }],
  tools: [],
})

describe("ScriptedProvider", () => {
  it("plays the script in order and records every request it was given", async () => {
    const provider = new ScriptedProvider([
      { text: "one", toolCalls: [] },
      { text: "two", toolCalls: [] },
    ])

    expect(provider.remaining).toBe(2)
    expect((await provider.converse(req("a"))).text).toBe("one")
    expect((await provider.converse(req("b"))).text).toBe("two")
    expect(provider.remaining).toBe(0)
    expect(provider.requests.map((r) => r.messages[0])).toEqual([
      { role: "user", text: "a" },
      { role: "user", text: "b" },
    ])
    expect(provider.name).toBe("scripted")
  })

  it("fails loud when the script runs out instead of inventing a turn", async () => {
    const provider = new ScriptedProvider([{ text: "only", toolCalls: [] }])
    await provider.converse(req("a"))
    await expect(provider.converse(req("b"))).rejects.toBeInstanceOf(ScriptExhaustedError)
    await expect(provider.converse(req("b"))).rejects.toThrow(/1 turn\(s\) played/)
  })

  it("lets a turn be a function of the request and its index", async () => {
    const provider = new ScriptedProvider([
      (r, i) => ({
        text: `${i}:${r.messages.length}:${r.providerOptions?.maxTokens ?? "-"}`,
        toolCalls: [],
      }),
      async (r) => ({ text: `async ${r.system}`, toolCalls: [] }),
    ])
    expect((await provider.converse({ ...req("a"), providerOptions: { maxTokens: 5 } })).text).toBe(
      "0:1:5",
    )
    expect((await provider.converse(req("b"))).text).toBe("async s")
  })

  it("records detached copies, so later mutation by the loop cannot rewrite history", async () => {
    const provider = new ScriptedProvider([{ text: "ok", toolCalls: [] }])
    const live = req("a")
    await provider.converse(live)
    live.messages.push({ role: "user", text: "appended later" })
    expect(provider.requests[0]?.messages).toHaveLength(1)
  })

  it("returns a deep copy of each turn, so a reused result object is never shared", async () => {
    const shared = {
      text: "",
      toolCalls: [{ id: "t", name: "x", input: { a: 1, nested: { list: [1, 2] } } }],
    }
    const provider = new ScriptedProvider([shared, shared])
    const first = await provider.converse(req("a"))
    // A tool that mutates its input, at the top level and inside nested data.
    first.toolCalls[0]!.input.a = 2
    ;(first.toolCalls[0]!.input.nested as { list: number[] }).list.push(3)
    const second = await provider.converse(req("b"))
    expect(second.toolCalls[0]?.input).toEqual({ a: 1, nested: { list: [1, 2] } })
    expect(shared.toolCalls[0]!.input).toEqual({ a: 1, nested: { list: [1, 2] } })
  })

  it("stamps its configured model on turns that name none", async () => {
    const provider = new ScriptedProvider(
      [
        { text: "a", toolCalls: [] },
        { text: "b", toolCalls: [], model: "served-elsewhere" },
      ],
      { model: "m-config", name: "replay" },
    )
    expect(provider.model).toBe("m-config")
    expect(provider.name).toBe("replay")
    expect((await provider.converse(req("a"))).model).toBe("m-config")
    expect((await provider.converse(req("b"))).model).toBe("served-elsewhere")
  })

  it("honours the abort signal like a real adapter", async () => {
    const provider = new ScriptedProvider([{ text: "never", toolCalls: [] }])
    await expect(provider.converse(req("a"), { signal: AbortSignal.abort("stop") })).rejects.toBe(
      "stop",
    )
    // An aborted call plays nothing.
    expect(provider.remaining).toBe(1)
  })

  it("plays a one-shot completion from the same script", async () => {
    const provider = new ScriptedProvider([{ text: "completed", toolCalls: [] }])
    expect(await provider.complete({ system: "s", prompt: "p" })).toBe("completed")
    expect(provider.requests[0]?.messages).toEqual([{ role: "user", text: "p" }])
  })

  it("declares usage only when told to", () => {
    expect(new ScriptedProvider([]).reportsUsage).toBe(false)
    expect(new ScriptedProvider([], { reportsUsage: true }).reportsUsage).toBe(true)
  })
})

describe("ScriptedProvider: raw arguments, meta and finish reason (0.11.0-next.1)", () => {
  it("preserves argumentsText and meta on the turns it plays, detached", async () => {
    const meta = { thoughtSignature: "sig-1" }
    const provider = new ScriptedProvider([
      {
        text: "",
        toolCalls: [{ id: "t", name: "x", input: { a: 1 }, argumentsText: '{"a":1}', meta }],
        finishReason: "tool_calls",
      },
    ])
    const played = await provider.converse(req("a"))
    expect(played.finishReason).toBe("tool_calls")
    expect(played.toolCalls[0]).toMatchObject({
      argumentsText: '{"a":1}',
      meta: { thoughtSignature: "sig-1" },
    })
    expect(played.toolCalls[0]?.meta).not.toBe(meta)
  })

  it("leaves finishReason absent when the script says nothing, so old scripts behave as before", async () => {
    const played = await new ScriptedProvider([{ text: "ok", toolCalls: [] }]).converse(req("a"))
    expect(played.finishReason).toBeUndefined()
  })
})
