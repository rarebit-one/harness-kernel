import type {
  AgentMessage,
  ConverseRequest,
  ConverseResult,
  Provider,
  ToolSpec,
} from "../providers/types.js"
import {
  requireCapability,
  type Health,
  type InvokeContext,
  type ModelCaps,
  type ModelInvocation,
  type ModelResult,
} from "./types.js"

/**
 * A reference to binary content a multimodal request carries. Inline base64 for
 * content the caller already holds; a URL when the provider should fetch it.
 */
export type BinaryRef =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; mediaType?: string; url: string }

/**
 * A non-text part of a chat request. Sending any of these requires
 * `caps.multimodalInput`; a model that lacks it rejects the request rather than
 * quietly dropping the attachment.
 */
export type ChatPart =
  | { type: "image"; source: BinaryRef }
  | { type: "audio"; source: BinaryRef }
  | { type: "binary"; source: BinaryRef }

/**
 * The `chat` kind's request. It is the existing {@link ConverseRequest} plus an
 * optional multimodal channel, so every current caller's request is already a
 * valid `ChatRequest`.
 */
export interface ChatRequest extends ConverseRequest {
  /** Attachments for the latest user turn. Requires `caps.multimodalInput`. */
  parts?: ChatPart[]
}

/** The `chat` kind's result: prose plus the tool calls that drive the loop. */
export type ChatResponse = ConverseResult

/** The `chat` kind's invocation type. */
export type ChatModel = ModelInvocation<ChatRequest, ChatResponse>

/** The kind string every chat model registers under. */
export const CHAT_KIND = "chat"

/**
 * Adapt a {@link Provider} onto the model seam as the `chat` kind.
 *
 * This wraps rather than rewrites: the provider's own `converse` still does the
 * work, so the tool-use loop's behaviour is unchanged. What the wrapper adds is
 * a uniform envelope, declared capabilities, and a place for middleware to sit —
 * the same place a perception model sits.
 *
 * Capabilities are reported conservatively, from what the `Provider` interface
 * can actually express: it has no streaming method and no attachment channel,
 * so those stay false. `usage` follows the provider's own `reportsUsage`
 * declaration: the SDK-backed adapters set it (their `ConverseResult.usage`
 * becomes `ModelResult.usage`), while a provider that declares nothing — the
 * mock, a custom provider — reports `usage: false` rather than promising
 * accounting it does not deliver.
 */
export function chatModel(provider: Provider, caps: Partial<ModelCaps> = {}): ChatModel {
  const resolved: ModelCaps = {
    streaming: false,
    tools: true,
    multimodalInput: false,
    usage: provider.reportsUsage === true,
    ...caps,
  }

  return {
    id: provider.name,
    kind: CHAT_KIND,
    caps: resolved,

    async invoke(req: ChatRequest, ctx: InvokeContext): Promise<ModelResult<ChatResponse>> {
      if (req.parts?.length) {
        requireCapability(
          { id: provider.name, kind: CHAT_KIND, caps: resolved },
          "multimodalInput",
          "request carries parts",
        )
      }
      if (req.tools.length > 0) {
        requireCapability(
          { id: provider.name, kind: CHAT_KIND, caps: resolved },
          "tools",
          "request carries tool definitions",
        )
      }
      ctx.signal?.throwIfAborted()

      const converseReq = { system: req.system, messages: req.messages, tools: req.tools }
      // The signal rides through to the provider's HTTP call, so an abort stops
      // the request in flight rather than after it returns. Passed only when
      // present so a provider with a one-argument `converse` sees no change.
      const value = ctx.signal
        ? await provider.converse(converseReq, { signal: ctx.signal })
        : await provider.converse(converseReq)
      return { value, ...(value.usage ? { usage: value.usage } : {}) }
    },

    // The `Provider` interface exposes no health endpoint, so report the honest
    // answer rather than inventing an `up` — a probe that always says "fine" is
    // worse than one that admits it doesn't know.
    probe(): Promise<Health> {
      return Promise.resolve({
        status: "unknown",
        detail: `provider ${provider.name} exposes no health endpoint`,
      })
    },
  }
}

/** True when a value is already a model invocation rather than a bare `Provider`. */
export function isChatModel(value: Provider | ChatModel): value is ChatModel {
  return "invoke" in value && "kind" in value && "caps" in value
}

/** Accept either a `Provider` or a `ChatModel` and always yield a `ChatModel`. */
export function asChatModel(value: Provider | ChatModel): ChatModel {
  return isChatModel(value) ? value : chatModel(value)
}

/** Build a `chat` request from the loop's working state. */
export function chatRequest(
  system: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
  parts?: ChatPart[],
): ChatRequest {
  return { system, messages, tools, ...(parts?.length ? { parts } : {}) }
}
