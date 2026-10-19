/**
 * Per-call provider options: the typed passthrough from a caller to the adapter
 * that makes the HTTP request.
 *
 * Two kinds of thing live here, and the split is deliberate:
 *
 *   - **Neutral options** (`maxTokens`, `promptCache`, `responseFormat`) name an
 *     intent, and each adapter maps it onto its own wire format as well as it
 *     can. Prompt caching is the clearest case: Anthropic wants explicit
 *     `cache_control` breakpoints, OpenRouter wants them inside content parts,
 *     OpenAI caches prefixes automatically and only takes a routing key.
 *   - **Adapter-addressed options** (`openrouter`) carry one API's own
 *     vocabulary verbatim, snake_case and all, because translating them would
 *     only add a place for the two to drift.
 *
 * Either way, an option an adapter cannot honour is an error, never a silent
 * drop: a caller that asked for zero-data-retention routing and got a request
 * that said nothing about it would have no way to notice.
 */

/** How long a cache breakpoint keeps its entry alive (Anthropic and OpenRouter). */
export type CacheTtl = "5m" | "1h"

/**
 * Where to place prompt-cache breakpoints. Every field is optional; passing
 * `promptCache: {}` means "cache this prompt the usual way": the system prompt,
 * the tool definitions and the last message, so the next call in the same
 * conversation reads the whole prefix from cache.
 *
 * Breakpoints exist on Anthropic (`cache_control`) and OpenRouter (content
 * parts). The `openai` adapter has no breakpoints to place (its caching is
 * automatic over the prefix) and honours only `key`; the `local` adapter and
 * any custom OpenAI-compatible endpoint accept the option and leave caching to
 * the server's own prefix cache. Those two are best effort by design rather
 * than an error: "cache this prompt" is an intent every adapter can honour as
 * well as its API allows, unlike an option addressed to a different API.
 */
export interface PromptCacheOptions {
  /** Breakpoint after the system prompt. Default `true`. */
  system?: boolean
  /** Breakpoint after the tool definitions (Anthropic only). Default `true`. */
  tools?: boolean
  /**
   * How many trailing messages get a breakpoint on their last content block.
   * Default 1; clamped to {@link MAX_TRAILING_CACHE_MESSAGES} because Anthropic
   * allows four breakpoints per request and two are spent on system and tools.
   */
  trailingMessages?: number
  /** Cache lifetime for every breakpoint this call places. Default is the provider's (`5m`). */
  ttl?: CacheTtl
  /** OpenAI `prompt_cache_key`: routes requests sharing a prefix to the same cache. */
  key?: string
}

/** Anthropic's breakpoint ceiling is four; two go to system and tools. */
export const MAX_TRAILING_CACHE_MESSAGES = 2

/** The resolved form of {@link PromptCacheOptions}: every default applied. */
export interface ResolvedPromptCache {
  system: boolean
  tools: boolean
  trailingMessages: number
  ttl?: CacheTtl
  key?: string
}

/** Apply the defaults and the clamp. */
export function resolvePromptCache(options: PromptCacheOptions): ResolvedPromptCache {
  const requested = options.trailingMessages ?? 1
  const trailingMessages = Math.max(
    0,
    Math.min(MAX_TRAILING_CACHE_MESSAGES, Number.isFinite(requested) ? Math.floor(requested) : 1),
  )
  return {
    system: options.system ?? true,
    tools: options.tools ?? true,
    trailingMessages,
    ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
  }
}

/**
 * The OpenAI chat.completions `response_format` shape, which OpenRouter and most
 * OpenAI-compatible servers accept as-is. The Anthropic adapter rejects it: the
 * Messages API has no equivalent field, and a structured answer there is a
 * terminal tool with a schema.
 */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema"
      json_schema: {
        name: string
        description?: string
        schema?: Record<string, unknown>
        strict?: boolean | null
      }
    }

/**
 * OpenRouter's `provider` routing preferences, passed through verbatim (hence
 * snake_case: these are OpenRouter's own field names). `data_collection: "deny"`
 * and `zdr: true` are the data-policy knobs: the first excludes upstreams that
 * may store or train on prompts, the second restricts routing to upstreams
 * with a zero-data-retention policy.
 */
export interface OpenRouterProviderPreferences {
  /** Upstreams to try, in order. */
  order?: string[]
  /** Only these upstreams may serve the request. */
  only?: string[]
  /** Never route to these upstreams. */
  ignore?: string[]
  /** Whether to fall back past `order` when those upstreams fail. */
  allow_fallbacks?: boolean
  /** Only route to upstreams that support every parameter in the request. */
  require_parameters?: boolean
  /** `deny` excludes upstreams that may store or train on the prompt. */
  data_collection?: "allow" | "deny"
  /** Restrict routing to upstreams with a zero-data-retention policy. */
  zdr?: boolean
  /** Routing priority when several upstreams qualify. */
  sort?: "price" | "throughput" | "latency" | (string & {})
  /** Acceptable quantization levels, e.g. `["fp16", "bf16"]`. */
  quantizations?: string[]
  /** Price ceilings per million tokens, in OpenRouter's own keys (`prompt`, `completion`, …). */
  max_price?: Record<string, number>
}

/** Options only the OpenRouter adapter can honour. */
export interface OpenRouterOptions {
  /** Fallback model ids, tried in order when the primary model fails or is unavailable. */
  models?: string[]
  /** Upstream routing and data-policy preferences. */
  provider?: OpenRouterProviderPreferences
  /** `{ include: true }` asks for token accounting (incl. cache reads) in the response. */
  usage?: { include: boolean }
  /** OpenRouter prompt transforms, e.g. `["middle-out"]`. */
  transforms?: string[]
}

/**
 * Which tool the model must call. `auto` lets it choose (the provider
 * default), `required` forces some tool, `none` forbids tools, `{ name }`
 * forces that one (the last step of a terminal-tool flow). Every adapter
 * omits the setting on a request that carries no tools, which is what the
 * loop's budget-summary call sends, so a forced choice never reaches a call
 * that has nothing to choose from.
 */
export type ToolChoice = "auto" | "required" | "none" | { name: string }

/** Everything a caller may hand an adapter for one request. */
export interface ProviderOptions {
  /** Sampling temperature, passed through as given. */
  temperature?: number
  /** Which tool the model must call; see {@link ToolChoice}. */
  toolChoice?: ToolChoice
  /** Completion token cap for this call; overrides `RUNNER_MAX_TOKENS`. */
  maxTokens?: number
  /**
   * SDK retry count for this call; overrides `RUNNER_PROVIDER_MAX_RETRIES`.
   * Set `0` when the request carries its own fallback chain (OpenRouter
   * `models`), so a transient upstream failure is not retried by the SDK and
   * then again by the router.
   */
  maxRetries?: number
  /** Prompt caching. Each adapter maps it onto its own mechanism. */
  promptCache?: PromptCacheOptions
  /** Structured-output format (OpenAI-compatible adapters only). */
  responseFormat?: ResponseFormat
  /** OpenRouter-only routing options; any other adapter rejects them. */
  openrouter?: OpenRouterOptions
}

/**
 * Thrown when an option is addressed to an adapter that cannot honour it. The
 * kernel never drops an option on the floor: silence here is how a request
 * meant for a zero-data-retention route ends up somewhere else.
 */
export class ProviderOptionsError extends Error {
  readonly adapter: string
  readonly option: keyof ProviderOptions

  constructor(adapter: string, option: keyof ProviderOptions, detail?: string) {
    super(
      `provider "${adapter}" does not support providerOptions.${option}${detail ? ` (${detail})` : ""}`,
    )
    this.name = "ProviderOptionsError"
    this.adapter = adapter
    this.option = option
  }
}

/** Throw if `options` carries `option`, for an adapter that cannot honour it. */
export function rejectOption(
  adapter: string,
  options: ProviderOptions | undefined,
  option: keyof ProviderOptions,
  detail?: string,
): void {
  if (options?.[option] !== undefined) throw new ProviderOptionsError(adapter, option, detail)
}

/** The per-call retry count when given and non-negative, else undefined (the client's default). */
export function resolveMaxRetries(options: ProviderOptions | undefined): number | undefined {
  const n = options?.maxRetries
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * The per-call completion cap: the option when given and positive, else the
 * caller's fallback (normally the env-resolved `RUNNER_MAX_TOKENS`).
 */
export function resolveMaxTokens(options: ProviderOptions | undefined, fallback: number): number {
  const n = options?.maxTokens
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
