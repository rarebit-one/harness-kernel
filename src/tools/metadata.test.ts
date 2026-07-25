import { describe, it, expect } from "vitest"
import {
  isToolVisible,
  selectTools,
  toToolSpecs,
  toolsRequiringConfirmation,
  undoToolFor,
} from "./metadata.js"
import type { ToolMetadata } from "./metadata.js"
import type { Tool } from "./registry.js"

function tool(name: string, meta?: ToolMetadata): Tool {
  return {
    spec: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
    ...(meta ? { meta } : {}),
    execute: () => Promise.resolve("ok"),
  }
}

describe("tool visibility", () => {
  it("shows a tool that declares no metadata to everyone", () => {
    const plain = tool("run_code")
    expect(isToolVisible(plain)).toBe(true)
    expect(isToolVisible(plain, { capability: "anything", mode: "system_initiated" })).toBe(true)
  })

  it("scopes a tool to the capabilities it targets", () => {
    const scoped = tool("book", { targetCapabilities: ["booking"] })

    expect(isToolVisible(scoped, { capability: "booking" })).toBe(true)
    expect(isToolVisible(scoped, { capability: "search" })).toBe(false)
  })

  it("hides a capability-scoped tool from an unscoped resolution (fails closed)", () => {
    const scoped = tool("book", { targetCapabilities: ["booking"] })
    expect(isToolVisible(scoped, {})).toBe(false)
  })

  it("gates a tool by invocation mode", () => {
    const systemOnly = tool("create_event", { invocationModes: ["system_initiated"] })

    expect(isToolVisible(systemOnly, { mode: "system_initiated" })).toBe(true)
    expect(isToolVisible(systemOnly, { mode: "user_initiated" })).toBe(false)
    // A mode-scoped tool must never leak into a resolution that names no mode.
    expect(isToolVisible(systemOnly, {})).toBe(false)
  })

  it("honours a plain name allowlist alongside metadata", () => {
    expect(isToolVisible(tool("read_file"), { allowed: ["read_file"] })).toBe(true)
    expect(isToolVisible(tool("run_code"), { allowed: ["read_file"] })).toBe(false)
  })

  it("selects the visible subset of a surface", () => {
    const tools = [
      tool("run_code"),
      tool("book", { targetCapabilities: ["booking"] }),
      tool("create_event", { invocationModes: ["system_initiated"] }),
    ]

    expect(
      selectTools(tools, { capability: "booking", mode: "user_initiated" }).map((t) => t.spec.name),
    ).toEqual(["run_code", "book"])
  })
})

describe("provider projection", () => {
  it("projects away everything a model has no use for", () => {
    const rich = tool("book", {
      displayName: "Book a table",
      targetCapabilities: ["booking"],
      invocationModes: ["user_initiated"],
      requiresConfirmation: true,
      reversible: true,
      undoToolName: "cancel",
      undoWindowSeconds: 600,
      resultRetention: "persistent",
      clientResultVisibility: "suppressed",
    })

    expect(toToolSpecs([rich])).toEqual([
      { name: "book", description: "the book tool", inputSchema: { type: "object" } },
    ])
  })
})

describe("confirmation and undo metadata", () => {
  it("surfaces the tools a caller must confirm", () => {
    const tools = [tool("read_file"), tool("book", { requiresConfirmation: true })]
    expect(toolsRequiringConfirmation(tools).map((t) => t.spec.name)).toEqual(["book"])
  })

  it("finds the tool that undoes a reversible one", () => {
    const tools = [tool("book", { reversible: true, undoToolName: "cancel" }), tool("cancel")]
    expect(undoToolFor(tools, "book")?.spec.name).toBe("cancel")
  })

  it("returns nothing for a tool that is not reversible", () => {
    const tools = [tool("book", { undoToolName: "cancel" }), tool("cancel")]
    expect(undoToolFor(tools, "book")).toBeUndefined()
  })
})
