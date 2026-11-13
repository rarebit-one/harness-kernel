import { describe, it, expect } from "vitest"
// Imported from the public entry point on purpose: `RunStartedEvent.tools`
// tells callers to narrow with `isToolVisible`, so it must be importable there.
import { MockProvider, NativeEngine, isToolVisible, recordRunEvents, runAgent } from "./index.js"
import type { RunEvent, RunSpec, Tool, ToolMetadata } from "./index.js"

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

  describe("through NativeEngine", () => {
    const engineSpec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
      runId: "r",
      workspaceId: "ws",
      workflowPath: "wf.yml",
      workflow: { name: "Demo", prompt: "Do it." },
      inputs: {},
      context: "",
      workdir: "/tmp",
      // An empty allowlist keeps the primitives out, so the surface is the domain tools.
      permissions: { tools: [] },
      secrets: {},
      connectors: [],
      provider: { preferred: "mock" },
      ...overrides,
    })
    const engine = new NativeEngine({ domainTools: () => surface })

    it("hands the loop every tool when the spec names no capability or mode", async () => {
      const { sink, events } = recordRunEvents()
      await engine.run(engineSpec(), { log: () => {}, emit: sink })
      expect(startedTools(events)).toEqual(["plain", "book", "nightly"])
    })

    it("scopes the surface by the spec's capability and mode before the loop starts", async () => {
      const { sink, events } = recordRunEvents()
      await engine.run(engineSpec({ capability: "booking" }), { log: () => {}, emit: sink })
      expect(startedTools(events)).toEqual(["plain", "book"])

      const nightly = recordRunEvents()
      await engine.run(engineSpec({ mode: "system_initiated" }), {
        log: () => {},
        emit: nightly.sink,
      })
      expect(startedTools(nightly.events)).toEqual(["plain", "nightly"])
    })
  })
})
