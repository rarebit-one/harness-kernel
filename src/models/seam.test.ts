import { describe, it, expect, vi } from "vitest"
import { MockProvider } from "../providers/mock.js"
import { chatModel, type ChatModel, type ChatRequest, type ChatResponse } from "./chat.js"
import {
  correlationMiddleware,
  errorRedactionMiddleware,
  healthTrackingMiddleware,
  HealthTracker,
  loggingMiddleware,
  withMiddleware,
  type Middleware,
} from "./middleware.js"
import { ModelRegistry, UnknownModelError } from "./registry.js"
import {
  CapabilityError,
  invokeStreaming,
  type InvokeContext,
  type ModelInvocation,
  type ModelResult,
  type StreamSink,
} from "./types.js"

// ── A fake perception kind ───────────────────────────────────────────────────
// Deliberately nothing like a chat model: binary request in, struct out, no
// tools. If the seam is general enough, defining and registering this needs no
// kernel change whatsoever — that is exactly what these tests assert.

interface DetectRequest {
  image: { mediaType: string; data: string }
  minConfidence?: number
}

interface Detection {
  label: string
  confidence: number
}

interface DetectionResult {
  detections: Detection[]
  width: number
  height: number
}

type DetectModel = ModelInvocation<DetectRequest, DetectionResult>

function fakeDetector(id = "fake-detector", detections: Detection[] = []): DetectModel {
  return {
    id,
    kind: "vision.detect",
    caps: { streaming: false, tools: false, multimodalInput: true, usage: true },
    invoke: (req: DetectRequest) => {
      const min = req.minConfidence ?? 0
      return Promise.resolve({
        value: {
          detections: detections.filter((d) => d.confidence >= min),
          width: 640,
          height: 480,
        },
        usage: { units: 1, unit: "frames" },
      })
    },
    probe: () => Promise.resolve({ status: "up" as const }),
  }
}

const ctx = (): InvokeContext => ({ log: () => {} })

describe("model registry", () => {
  // (a) A brand-new kind registers and resolves with no kernel-code edit
  //     beyond the registration call itself.
  it("registers and resolves a perception kind the kernel has never heard of", async () => {
    const registry = new ModelRegistry()
    registry.register<DetectRequest, DetectionResult>({ kind: "vision.detect", id: "fake" }, () =>
      fakeDetector("fake", [
        { label: "cat", confidence: 0.9 },
        { label: "rug", confidence: 0.2 },
      ]),
    )

    const model = registry.resolve<DetectRequest, DetectionResult>({
      kind: "vision.detect",
      id: "fake",
    })

    expect(model.kind).toBe("vision.detect")
    expect(model.caps.tools).toBe(false)

    const result = await model.invoke(
      { image: { mediaType: "image/png", data: "AAAA" }, minConfidence: 0.5 },
      ctx(),
    )

    // The typed result survives the round trip — it is not stringified away.
    expect(result.value.detections).toEqual([{ label: "cat", confidence: 0.9 }])
    expect(result.value.width).toBe(640)
    expect(result.usage).toEqual({ units: 1, unit: "frames" })
  })

  it("keeps chat and perception kinds side by side under one registry", () => {
    const registry = new ModelRegistry()
      .registerInstance(chatModel(new MockProvider()))
      .registerInstance(fakeDetector())

    expect(registry.kinds().sort()).toEqual(["chat", "vision.detect"])
    expect(registry.ids("vision.detect")).toEqual(["fake-detector"])
    expect(registry.registered().sort()).toEqual(["chat:mock", "vision.detect:fake-detector"])
  })

  it("fails loud on an unresolved ref rather than returning undefined", () => {
    const registry = new ModelRegistry().registerInstance(fakeDetector())

    expect(() => registry.resolve({ kind: "audio.asr", id: "whisper" })).toThrow(UnknownModelError)
    expect(() => registry.resolve({ kind: "audio.asr", id: "whisper" })).toThrow(
      /no model registered for audio.asr:whisper/,
    )
  })

  it("reports support with a reason, mirroring the engine gate", () => {
    const registry = new ModelRegistry().registerInstance(fakeDetector())

    expect(registry.supports({ kind: "vision.detect", id: "fake-detector" })).toEqual({ ok: true })
    const missing = registry.supports({ kind: "chat", id: "nope" })
    expect(missing.ok).toBe(false)
    expect(missing.ok === false && missing.reason).toMatch(/no model registered for chat:nope/)
  })

  it("refuses to silently overwrite a registered ref", () => {
    const registry = new ModelRegistry().registerInstance(fakeDetector())
    expect(() => registry.registerInstance(fakeDetector())).toThrow(/already registered/)
  })
})

describe("capability gating", () => {
  it("refuses to stream a model that declared it cannot", async () => {
    const model = fakeDetector()
    await expect(
      invokeStreaming(model, { image: { mediaType: "x", data: "y" } }, {}, ctx()),
    ).rejects.toThrow(CapabilityError)
  })

  it("refuses multimodal parts on a chat model that lacks the capability", async () => {
    const model = chatModel(new MockProvider())
    expect(model.caps.multimodalInput).toBe(false)

    await expect(
      model.invoke(
        {
          system: "s",
          messages: [{ role: "user", text: "what is this?" }],
          tools: [],
          parts: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "A" } }],
        },
        ctx(),
      ),
    ).rejects.toThrow(/does not support multimodalInput/)
  })

  it("accepts multimodal parts once the adapter declares the capability", async () => {
    const model = chatModel(new MockProvider(), { multimodalInput: true })

    const result = await model.invoke(
      {
        system: "s",
        messages: [{ role: "user", text: "what is this?" }],
        tools: [],
        parts: [{ type: "image", source: { kind: "url", url: "https://example/i.png" } }],
      },
      ctx(),
    )

    expect(typeof result.value.text).toBe("string")
  })
})

describe("middleware", () => {
  // (b) ONE middleware instance wraps an LLM invocation and a perception
  //     invocation through the same code path.
  it("wraps both a chat model and a perception model via the same code path", async () => {
    const seen: string[] = []
    const spy: Middleware = {
      name: "spy",
      invoke: (next, model) => async (req, c) => {
        seen.push(`${model.kind}:${model.id}`)
        return next(req, c)
      },
    }

    const chat = withMiddleware(chatModel(new MockProvider()), [spy])
    const detect = withMiddleware(fakeDetector(), [spy])

    await chat.invoke({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] }, ctx())
    await detect.invoke({ image: { mediaType: "image/png", data: "AAAA" } }, ctx())

    expect(seen).toEqual(["chat:mock", "vision.detect:fake-detector"])
  })

  it("applies middleware to everything the registry hands out", async () => {
    const seen: string[] = []
    const registry = new ModelRegistry()
      .use({
        name: "spy",
        invoke: (next, model) => (req, c) => {
          seen.push(model.kind)
          return next(req, c)
        },
      })
      .registerInstance(chatModel(new MockProvider()))
      .registerInstance(fakeDetector())

    await registry
      .resolve<ChatRequest, ChatResponse>({ kind: "chat", id: "mock" })
      .invoke({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] }, ctx())
    await registry
      .resolve<DetectRequest, DetectionResult>({ kind: "vision.detect", id: "fake-detector" })
      .invoke({ image: { mediaType: "image/png", data: "A" } }, ctx())

    expect(seen).toEqual(["chat", "vision.detect"])
  })

  it("runs middleware outermost-first", async () => {
    const order: string[] = []
    const tag = (name: string): Middleware => ({
      name,
      invoke: (next) => async (req, c) => {
        order.push(`>${name}`)
        const out = await next(req, c)
        order.push(`<${name}`)
        return out
      },
    })

    const model = withMiddleware(fakeDetector(), [tag("outer"), tag("inner")])
    await model.invoke({ image: { mediaType: "x", data: "y" } }, ctx())

    expect(order).toEqual([">outer", ">inner", "<inner", "<outer"])
  })

  it("does not fabricate a streaming capability the model lacks", () => {
    const wrapped = withMiddleware(fakeDetector(), [loggingMiddleware()])
    expect("invokeStream" in wrapped).toBe(false)
    expect(wrapped.caps.streaming).toBe(false)
  })

  it("wraps invokeStream when the model does support it", async () => {
    const streamer: ModelInvocation<string, string> = {
      id: "s",
      kind: "chat",
      caps: { streaming: true, tools: false, multimodalInput: false, usage: false },
      invoke: (req) => Promise.resolve({ value: req }),
      invokeStream: (req: string, sink: StreamSink) => {
        sink.onTextDelta?.(req)
        return Promise.resolve({ value: req })
      },
      probe: () => Promise.resolve({ status: "up" as const }),
    }

    const wrapped = withMiddleware(streamer, [loggingMiddleware()])
    const deltas: string[] = []
    const result = await invokeStreaming(
      wrapped,
      "hello",
      { onTextDelta: (d) => deltas.push(d) },
      ctx(),
    )

    expect(deltas).toEqual(["hello"])
    expect(result.value).toBe("hello")
  })

  it("mints a correlation id once and leaves a supplied one alone", async () => {
    const ids: (string | undefined)[] = []
    const capture: Middleware = {
      name: "capture",
      invoke: (next) => (req, c) => {
        ids.push(c.correlationId)
        return next(req, c)
      },
    }

    const model = withMiddleware(fakeDetector(), [correlationMiddleware(() => "minted"), capture])
    await model.invoke({ image: { mediaType: "x", data: "y" } }, ctx())
    await model.invoke({ image: { mediaType: "x", data: "y" } }, { ...ctx(), correlationId: "own" })

    expect(ids).toEqual(["minted", "own"])
  })

  it("tracks health from real traffic, for any kind", async () => {
    const tracker = new HealthTracker()
    const failing: DetectModel = {
      ...fakeDetector("broken"),
      invoke: () => Promise.reject(new Error("gateway down")),
    }

    const ok = withMiddleware(fakeDetector("good"), [healthTrackingMiddleware(tracker)])
    const bad = withMiddleware(failing, [healthTrackingMiddleware(tracker)])

    await ok.invoke({ image: { mediaType: "x", data: "y" } }, ctx())
    await expect(bad.invoke({ image: { mediaType: "x", data: "y" } }, ctx())).rejects.toThrow()

    expect(tracker.snapshot()).toEqual({
      "vision.detect:good": { status: "up" },
      "vision.detect:broken": { status: "down", detail: "gateway down" },
    })
  })

  it("redacts errors on their way out", async () => {
    const failing: DetectModel = {
      ...fakeDetector(),
      invoke: () => Promise.reject(new Error("token sk-secret leaked")),
    }
    const model = withMiddleware(failing, [
      errorRedactionMiddleware(
        (err) => new Error(String((err as Error).message).replace(/sk-\S+/, "[redacted]")),
      ),
    ])

    await expect(model.invoke({ image: { mediaType: "x", data: "y" } }, ctx())).rejects.toThrow(
      "token [redacted] leaked",
    )
  })

  it("logs each invocation's outcome through the run log", async () => {
    const log = vi.fn()
    const model = withMiddleware(fakeDetector(), [loggingMiddleware()])
    await model.invoke({ image: { mediaType: "x", data: "y" } }, { log })

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^model vision\.detect:fake-detector ok/),
    )
  })
})

describe("chat adapter", () => {
  it("puts an existing Provider on the seam without changing its answer", async () => {
    const provider = new MockProvider()
    const model: ChatModel = chatModel(provider)

    const direct = await provider.converse({
      system: "s",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    })
    const viaSeam: ModelResult<ChatResponse> = await model.invoke(
      { system: "s", messages: [{ role: "user", text: "hi" }], tools: [] },
      ctx(),
    )

    expect(viaSeam.value).toEqual(direct)
    expect(model.id).toBe("mock")
    expect(model.kind).toBe("chat")
  })

  it("admits it cannot report health rather than claiming to be up", async () => {
    await expect(chatModel(new MockProvider()).probe()).resolves.toEqual({
      status: "unknown",
      detail: "provider mock exposes no health endpoint",
    })
  })
})
