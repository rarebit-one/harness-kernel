import { AnthropicProvider } from "./anthropic.js"
import { OpenAIProvider } from "./openai.js"
import { OpenRouterProvider } from "./openrouter.js"
import { MockProvider } from "./mock.js"
import type { Provider } from "./types.js"

export type { Provider, CompletionRequest } from "./types.js"

/** Per-run model + bring-your-own keys, resolved control-plane side (see RunPayload.provider). */
export interface ProviderSelection {
  /** Model id for this run; falls back to the provider's env model when absent. */
  model?: string | null
  /** Per-org provider API keys; each falls back to the runner's env key when absent. */
  credentials?: { anthropic?: string; openai?: string; openrouter?: string }
}

/**
 * Resolves a provider from the workflow's preference and the runner's
 * environment. Jumpdrive is provider-agnostic; when the preferred provider
 * has no credentials we degrade to the offline mock rather than failing the
 * run, which keeps the platform runnable end-to-end without keys.
 *
 * `opts` carries the per-run model and per-org BYO keys; both fall back to the
 * runner's env (model via the provider constructor's env default, keys below).
 */
export function selectProvider(preferred?: string | null, opts: ProviderSelection = {}): Provider {
  const anthropicKey = opts.credentials?.anthropic ?? process.env.ANTHROPIC_API_KEY
  const openaiKey = opts.credentials?.openai ?? process.env.OPENAI_API_KEY
  const openrouterKey = opts.credentials?.openrouter ?? process.env.OPENROUTER_API_KEY
  // undefined → the provider constructor's env-default model kicks in.
  const model = opts.model ?? undefined

  switch (preferred) {
    case "anthropic":
      if (anthropicKey) return new AnthropicProvider(anthropicKey, model)
      break
    case "openai":
      if (openaiKey) return new OpenAIProvider(openaiKey, model)
      break
    case "openrouter":
      if (openrouterKey) return new OpenRouterProvider(openrouterKey, model)
      break
    case "mock":
      // An explicit `preferred: mock` always gets the mock, even when a key is
      // configured — it's the offline dry-run lens, so honour it deterministically
      // rather than silently upgrading to a real provider. Hand it the full
      // selection so it can self-document the model + BYO key it WOULD have used.
      return new MockProvider(opts)
  }

  // No explicit (or usable) preference: pick whatever is configured.
  if (anthropicKey) return new AnthropicProvider(anthropicKey, model)
  if (openaiKey) return new OpenAIProvider(openaiKey, model)
  if (openrouterKey) return new OpenRouterProvider(openrouterKey, model)
  // The offline fallback still carries the selection, so a keyless run's output
  // artifact reports the model (and any BYO key) the control plane resolved.
  return new MockProvider(opts)
}
