import { describe, it, expect } from "vitest"
// Imported from the public entry point on purpose: `RunStartedEvent.tools`
// tells callers to narrow with `isToolVisible`, so it must be importable there.
import { MockProvider, isToolVisible, recordRunEvents, runAgent } from "./index.js"
import type { RunEvent, Tool, ToolMetadata } from "./index.js"

function tool(name: string, meta?: ToolMetadata): Tool {
  return {
    spec: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
    ...(meta ? { meta } : {}),
    execute: () => Promise.resolve("ok"),
  }
}

const startedTools = (events: RunEvent[]): string[] | undefined => {
  const started = events.find((e) => e.type === "run.started")
  return started?.type === "run.started" ? started.tools : undefined
}

describe("run.started tool surface and metadata scoping", () => {
  const surface = [
    tool("plain"),
    tool("book", { targetCapabilities: ["booking"] }),
    tool("nightly", { invocationModes: ["system_initiated"] }),
  ]

  it("reports every tool it was handed: the loop applies no metadata scoping", async () => {
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new MockProvider(),
      system: "s",
      userPrompt: "go",
      tools: surface,
      emit: sink,
    })

    expect(startedTools(events)).toEqual(["plain", "book", "nightly"])
  })

  it("reports the narrowed surface once the caller filters with isToolVisible", async () => {
    const selection = { capability: "booking" }
    const { sink, events } = recordRunEvents()
    await runAgent({
      provider: new MockProvider(),
      system: "s",
      userPrompt: "go",
      tools: surface.filter((t) => isToolVisible(t, selection)),
      emit: sink,
    })

    expect(startedTools(events)).toEqual(["plain", "book"])
  })
})
