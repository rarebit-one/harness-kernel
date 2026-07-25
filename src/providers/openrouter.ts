import { OpenAICompatibleProvider } from "./openai.js"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Default model when neither the payload nor OPENROUTER_MODEL specifies one.
 * OpenRouter model ids are provider-namespaced (`anthropic/...`, `openai/...`)
 * and pass through to the API untouched.
 */
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4.5"

/**
 * OpenRouter speaks the OpenAI chat.completions dialect (including tools), so
 * this is the shared OpenAI-compatible core pointed at openrouter.ai with the
 * attribution headers OpenRouter's convention asks apps to send.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model = process.env.OPENROUTER_MODEL ?? OPENROUTER_DEFAULT_MODEL) {
    super("openrouter", {
      apiKey,
      model,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://jumpdrive.app",
        "X-Title": "Jumpdrive",
      },
    })
  }
}
