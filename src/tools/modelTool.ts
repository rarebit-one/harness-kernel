import type { InvokeContext, ModelInvocation, ModelResult } from "../models/types.js"
import type { ToolMetadata } from "./metadata.js"
import type { Tool, ToolOutput } from "./registry.js"

/** How to turn one model invocation into a callable tool. */
export interface ModelToolOptions<Req, Res> {
  /** Tool name the model calls. */
  name: string
  description: string
  /** JSON-Schema shape advertised to the model. */
  inputSchema: Record<string, unknown>
  /** Map the model's raw tool input to the invocation's request type. */
  toRequest: (input: Record<string, unknown>) => Req
  /**
   * Project the result down to the string the calling model sees. Defaults to
   * JSON — fine for a struct, worth overriding when a short natural-language
   * summary would spend less context than the full payload.
   */
  toContent?: (result: ModelResult<Res>) => string
  meta?: ToolMetadata
}

/**
 * Surface a {@link ModelInvocation} as a {@link Tool}.
 *
 * This is the cleanest form of "extension, not fork": a perception model — a
 * `vision.detect` or an `audio.asr` — becomes something the chat loop can call,
 * without the loop, the engines, or any kernel code learning that perception
 * exists. The registry binds it, this wraps it, the agent calls it like any
 * other tool.
 *
 * The typed result survives the trip: `content` is the model-facing projection,
 * and `structured` carries the original `Res` for callers and clients that want
 * the real thing rather than a re-parsed string.
 */
export function modelAsTool<Req, Res>(
  model: ModelInvocation<Req, Res>,
  options: ModelToolOptions<Req, Res>,
  context: Partial<InvokeContext> = {},
): Tool {
  const project = options.toContent ?? ((result: ModelResult<Res>) => JSON.stringify(result.value))

  const run = async (input: Record<string, unknown>): Promise<ToolOutput> => {
    const ctx: InvokeContext = {
      log: context.log ?? (() => {}),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context.budget ? { budget: context.budget } : {}),
    }
    const result = await model.invoke(options.toRequest(input), ctx)
    return { content: project(result), structured: result.value }
  }

  return {
    spec: {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema,
    },
    ...(options.meta ? { meta: options.meta } : {}),
    execute: async (input) => (await run(input)).content,
    executeStructured: run,
  }
}
