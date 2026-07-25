import { OpenAICompatibleProvider } from "./openai.js"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Default model when neither the payload nor OPENROUTER_MODEL specifies one.
 * OpenRouter model ids are provider-namespaced (`anthropic/...`, `openai/...`)
 * and pass through to the API untouched.
 */
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4.5"

/**
 * The optional attribution OpenRouter's convention asks apps to send, used for
 * its public rankings. The kernel has no app identity of its own, so it sends
 * nothing unless the embedding application supplies one.
 */
export interface OpenRouterAttribution {
  /** App URL, sent as the `HTTP-Referer` header. */
  referer?: string
  /** App name, sent as the `X-Title` header. */
  title?: string
}

/** Build the attribution headers, omitting any the caller left unset. */
function attributionHeaders(attribution: OpenRouterAttribution): Record<string, string> {
  const headers: Record<string, string> = {}
  if (attribution.referer) headers["HTTP-Referer"] = attribution.referer
  if (attribution.title) headers["X-Title"] = attribution.title
  return headers
}

/**
 * OpenRouter speaks the OpenAI chat.completions dialect (including tools), so
 * this is the shared OpenAI-compatible core pointed at openrouter.ai. Pass
 * `attribution` to identify your app in OpenRouter's rankings; omit it and no
 * attribution headers are sent.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(
    apiKey: string,
    model = process.env.OPENROUTER_MODEL ?? OPENROUTER_DEFAULT_MODEL,
    attribution: OpenRouterAttribution = {},
  ) {
    const headers = attributionHeaders(attribution)
    super("openrouter", {
      apiKey,
      model,
      baseURL: OPENROUTER_BASE_URL,
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
    })
  }
}
