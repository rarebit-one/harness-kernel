import { describe, it, expect } from "vitest"
import { ModelRegistry } from "../models/registry.js"
import type { ModelInvocation } from "../models/types.js"
import { modelAsTool } from "./modelTool.js"
import { executeTool } from "./registry.js"

interface DetectRequest {
  image: string
}
interface DetectionResult {
  detections: { label: string; confidence: number }[]
}

const detector: ModelInvocation<DetectRequest, DetectionResult> = {
  id: "fake",
  kind: "vision.detect",
  caps: { streaming: false, tools: false, multimodalInput: true, usage: true },
  invoke: (req) =>
    Promise.resolve({
      value: { detections: [{ label: `seen:${req.image}`, confidence: 0.9 }] },
      usage: { units: 1, unit: "frames" },
    }),
  probe: () => Promise.resolve({ status: "up" as const }),
}

function detectTool(): ReturnType<typeof modelAsTool> {
  return modelAsTool(detector, {
    name: "detect_objects",
    description: "Detect objects in an image.",
    inputSchema: {
      type: "object",
      properties: { image: { type: "string" } },
      required: ["image"],
    },
    toRequest: (input) => ({ image: String(input.image) }),
  })
}

describe("modelAsTool", () => {
  it("surfaces a perception model as a tool the agent loop can call", async () => {
    const tool = detectTool()

    expect(tool.spec.name).toBe("detect_objects")
    expect(JSON.parse(await tool.execute({ image: "frame-1" }))).toEqual({
      detections: [{ label: "seen:frame-1", confidence: 0.9 }],
    })
  })

  it("preserves the typed result alongside the string the model sees", async () => {
    const output = await executeTool(detectTool(), { image: "frame-2" })

    expect(typeof output.content).toBe("string")
    // The struct is NOT lost to a JSON round trip — this is the whole point of
    // the structured channel.
    expect(output.structured).toEqual({
      detections: [{ label: "seen:frame-2", confidence: 0.9 }],
    })
  })

  it("accepts a custom projection when JSON would waste context", async () => {
    const tool = modelAsTool(detector, {
      name: "detect_objects",
      description: "Detect objects.",
      inputSchema: { type: "object" },
      toRequest: (input) => ({ image: String(input.image) }),
      toContent: (result) => result.value.detections.map((d) => d.label).join(", "),
    })

    expect(await tool.execute({ image: "frame-3" })).toBe("seen:frame-3")
  })

  it("carries tool metadata onto the wrapped tool", () => {
    const tool = modelAsTool(detector, {
      name: "detect_objects",
      description: "Detect objects.",
      inputSchema: { type: "object" },
      toRequest: (input) => ({ image: String(input.image) }),
      meta: { requiresConfirmation: false, resultRetention: "ephemeral" },
    })

    expect(tool.meta?.resultRetention).toBe("ephemeral")
  })

  it("goes registry → tool without the loop learning that perception exists", async () => {
    const registry = new ModelRegistry().registerInstance(detector)
    const resolved = registry.resolve<DetectRequest, DetectionResult>({
      kind: "vision.detect",
      id: "fake",
    })

    const tool = modelAsTool(resolved, {
      name: "detect_objects",
      description: "Detect objects.",
      inputSchema: { type: "object" },
      toRequest: (input) => ({ image: String(input.image) }),
    })

    const output = await executeTool(tool, { image: "frame-4" })
    expect(output.structured).toEqual({
      detections: [{ label: "seen:frame-4", confidence: 0.9 }],
    })
  })
})

describe("executeTool", () => {
  it("falls back to the plain string executor for a tool without a structured one", async () => {
    const output = await executeTool(
      {
        spec: { name: "plain", description: "d", inputSchema: {} },
        execute: () => Promise.resolve("just text"),
      },
      {},
    )

    expect(output).toEqual({ content: "just text" })
    expect(output.structured).toBeUndefined()
  })
})
