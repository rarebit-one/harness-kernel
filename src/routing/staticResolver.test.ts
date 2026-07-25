import { describe, it, expect } from "vitest"
import { chatModel } from "../models/chat.js"
import type { ChatRequest, ChatResponse } from "../models/chat.js"
import { ModelRegistry } from "../models/registry.js"
import { MockProvider } from "../providers/mock.js"
import { StaticRouteResolver } from "./staticResolver.js"
import { UnknownCapabilityError } from "./types.js"

describe("StaticRouteResolver", () => {
  // (d) A capability name resolves to a route whose model ref then binds
  //     through the registry — with no database and no infrastructure at all.
  it("resolves a capability to a route whose model binds through the registry", async () => {
    const registry = new ModelRegistry().registerInstance(chatModel(new MockProvider()))

    const resolver = new StaticRouteResolver([
      {
        name: "summarise-thread",
        model: { kind: "chat", id: "mock" },
        prompt: "Summarise the thread.",
        tools: ["read_file"],
        limits: { maxSteps: 4 },
      },
    ])

    const route = await resolver.resolve("summarise-thread")

    expect(route).toEqual({
      capability: "summarise-thread",
      model: { kind: "chat", id: "mock" },
      prompt: "Summarise the thread.",
      tools: ["read_file"],
      limits: { maxSteps: 4 },
    })

    // The resolver picked the bundle; the registry binds the implementation.
    // Two layers, one handoff — the ModelRef.
    const model = registry.resolve<ChatRequest, ChatResponse>(route.model)
    expect(model.id).toBe("mock")

    const result = await model.invoke(
      { system: route.prompt, messages: [{ role: "user", text: "go" }], tools: [] },
      { log: () => {} },
    )
    expect(typeof result.value.text).toBe("string")
  })

  it("fills defaults for the optional parts of a definition", async () => {
    const resolver = new StaticRouteResolver([
      { name: "bare", model: { kind: "vision.detect", id: "yolo" } },
    ])

    await expect(resolver.resolve("bare")).resolves.toEqual({
      capability: "bare",
      model: { kind: "vision.detect", id: "yolo" },
      prompt: "",
      tools: [],
      limits: {},
    })
  })

  it("carries application meta through resolution untouched", async () => {
    const resolver = new StaticRouteResolver([
      { name: "c", model: { kind: "chat", id: "mock" }, meta: { tier: "premium" } },
    ])

    const route = await resolver.resolve("c")
    expect(route.meta).toEqual({ tier: "premium" })
  })

  it("fails loud on an unknown capability instead of defaulting", async () => {
    const resolver = new StaticRouteResolver([{ name: "known", model: { kind: "chat", id: "m" } }])

    await expect(resolver.resolve("missing")).rejects.toThrow(UnknownCapabilityError)
    await expect(resolver.resolve("missing")).rejects.toThrow(
      /no route defined for capability "missing" — defined: known/,
    )
  })

  it("routes an unresolvable model ref to a loud registry failure, not a silent miss", async () => {
    const registry = new ModelRegistry()
    const resolver = new StaticRouteResolver([
      { name: "c", model: { kind: "vision.detect", id: "never-registered" } },
    ])

    const route = await resolver.resolve("c")
    expect(() => registry.resolve(route.model)).toThrow(/no model registered/)
  })

  it("allows redefinition, because a resolver is configuration", async () => {
    const resolver = new StaticRouteResolver([{ name: "c", model: { kind: "chat", id: "a" } }])
    resolver.define({ name: "c", model: { kind: "chat", id: "b" } })

    await expect(resolver.resolve("c")).resolves.toMatchObject({ model: { id: "b" } })
    expect(resolver.capabilities()).toEqual(["c"])
  })

  it("starts empty and is usable with zero configuration", () => {
    const resolver = new StaticRouteResolver()
    expect(resolver.capabilities()).toEqual([])
    expect(resolver.has("anything")).toBe(false)
  })
})
