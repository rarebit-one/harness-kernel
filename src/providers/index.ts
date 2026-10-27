import { AnthropicProvider } from "./anthropic.js"
import { OpenAIProvider } from "./openai.js"
import { OpenRouterProvider } from "./openrouter.js"
import { LocalProvider } from "./local.js"
import { MockProvider } from "./mock.js"
import type { Provider } from "./types.js"

export type { Provider, CompletionRequest } from "./types.js"

/** Per-run model + bring-your-own keys, resolved by the caller. */
export interface ProviderSelection {
  /** Model id for this run; falls back to the provider's env model when absent. */
  model?: string | null
  /** Per-org provider API keys; each falls back to the runner's env key when absent. */
  credentials?: { anthropic?: string; openai?: string; openrouter?: string; local?: string }
  /**
   * Per-provider base URLs, overriding each adapter's default endpoint — how
   * a run is pointed at a credential gateway or proxy. Absent leaves every
   * adapter on its default.
   */
  baseURLs?: { anthropic?: string; openai?: string; openrouter?: string }
  /**
   * Run on the offline mock when no credential resolves, instead of failing.
   * Off by default: a run that silently lands on the mock looks exactly like a
   * run that reached a model, and nothing on the wire tells them apart. Set it
   * for a keyless test rig or a local demo, never in production. An explicit
   * `preferred: "mock"` needs no opt-in; that is a request, not a fallback.
   */
  allowMockFallback?: boolean
}

/** The outcome of {@link providerAvailability}: mirrors `AgentEngine.supports()`. */
export type ProviderAvailability = { ok: true } | { ok: false; reason: string }

/**
 * Thrown by {@link selectProvider} when the run's provider cannot be resolved:
 * no credential for the one asked for, none configured at all, or a name the
 * kernel does not know. `missing` names what would have satisfied it (the env
 * var and the BYO slot), so the message tells an operator what to set; it is
 * empty for an unknown name, where nothing would.
 */
export class ProviderCredentialsError extends Error {
  readonly preferred: string | null
  readonly missing: string[]

  constructor(preferred: string | null | undefined, missing: string[], reason: string) {
    super(reason)
    this.name = "ProviderCredentialsError"
    this.preferred = preferred ?? null
    this.missing = missing
  }
}

const CLOUD = ["anthropic", "openai", "openrouter"] as const
type Cloud = (typeof CLOUD)[number]
const ENV_KEY: Record<Cloud, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

function isCloud(name: string | null | undefined): name is Cloud {
  return (CLOUD as readonly string[]).includes(name ?? "")
}

/** The resolved key per cloud provider: the org's BYO key, else the host's env key. */
function resolveKeys(opts: ProviderSelection): Record<Cloud, string | undefined> {
  return {
    anthropic: opts.credentials?.anthropic ?? process.env.ANTHROPIC_API_KEY,
    openai: opts.credentials?.openai ?? process.env.OPENAI_API_KEY,
    openrouter: opts.credentials?.openrouter ?? process.env.OPENROUTER_API_KEY,
  }
}

/** What satisfies a provider's credential, for the error message. */
function wouldSatisfy(name: Cloud): string[] {
  return [ENV_KEY[name], `credentials.${name}`]
}

/**
 * The one resolution, shared by {@link providerAvailability} and
 * {@link selectProvider} so the check and the construction cannot disagree.
 * Returns the provider to build, or the failure.
 */
type Resolution =
  | { kind: "cloud"; name: Cloud; key: string }
  | { kind: "local"; baseURL: string }
  | { kind: "mock" }
  | { kind: "missing"; error: ProviderCredentialsError }

function resolve(preferred: string | null | undefined, opts: ProviderSelection): Resolution {
  const keys = resolveKeys(opts)
  const missing = (reason: string, names: string[]): Resolution => ({
    kind: "missing",
    error: new ProviderCredentialsError(preferred, names, reason),
  })

  if (preferred === "mock") return { kind: "mock" }

  if (preferred === "local") {
    // The one provider that was always loud: it is chosen precisely to keep a
    // run on private inference (e.g. a data_class: pii workflow), so running it
    // anywhere else would defeat the point. A key is optional (a local server
    // usually needs none); the base URL is not — without it there is nothing
    // to point at. `allowMockFallback` does not apply here for the same reason.
    const baseURL = process.env.LOCAL_MODEL_BASE_URL
    if (!baseURL) {
      return missing(
        "provider.preferred is 'local' but LOCAL_MODEL_BASE_URL is not set — " +
          "refusing to run a private-inference workflow on another provider",
        ["LOCAL_MODEL_BASE_URL"],
      )
    }
    return { kind: "local", baseURL }
  }

  if (isCloud(preferred)) {
    const key = keys[preferred]
    if (key) return { kind: "cloud", name: preferred, key }
    // No falling through to another configured provider: a run that asked for
    // one model and quietly got another is the same failure as one that
    // quietly got the mock.
    if (opts.allowMockFallback) return { kind: "mock" }
    const [env, slot] = wouldSatisfy(preferred)
    return missing(
      `provider "${preferred}" was requested but no credential is configured: ` +
        `set ${env} on the host or pass ${slot} with the run ` +
        "(or set allowMockFallback to run offline on the mock)",
      wouldSatisfy(preferred),
    )
  }

  // A name the kernel does not know is a typo or a provider this kernel has no
  // adapter for. It is refused rather than read as "no preference": routing a
  // run that asked for "openia" to whichever key happens to be configured is
  // the silent substitution this contract exists to stop. (The mock opt-in is
  // for a missing credential, not a wrong name, so it does not apply.)
  if (typeof preferred === "string" && preferred.trim() !== "") {
    return missing(
      `provider "${preferred}" is not one this kernel knows; use one of ` +
        `${[...CLOUD, "local", "mock"].join(", ")}, or omit the preference`,
      [],
    )
  }

  // No preference (absent, null or blank): pick whatever is configured, in a
  // fixed order.
  for (const name of CLOUD) {
    const key = keys[name]
    if (key) return { kind: "cloud", name, key }
  }
  if (opts.allowMockFallback) return { kind: "mock" }
  return missing(
    "no provider credential is configured: set one of " +
      `${CLOUD.map((n) => ENV_KEY[n]).join(", ")} on the host or pass credentials with the run ` +
      "(or set allowMockFallback to run offline on the mock)",
    CLOUD.flatMap(wouldSatisfy),
  )
}

/**
 * Whether {@link selectProvider} would succeed, as a reason rather than a
 * throw, so an engine's `supports()` can refuse a run before it starts. Pure:
 * it constructs no client.
 */
export function providerAvailability(
  preferred?: string | null,
  opts: ProviderSelection = {},
): ProviderAvailability {
  const resolution = resolve(preferred, opts)
  return resolution.kind === "missing"
    ? { ok: false, reason: resolution.error.message }
    : { ok: true }
}

/**
 * Resolves a provider from the workflow's preference and the host's
 * environment.
 *
 * It fails loud: a preferred provider with no credential, or no preference and
 * no credential at all, throws a {@link ProviderCredentialsError} naming what
 * would have satisfied it. The offline mock is reached only on request
 * (`preferred: "mock"`) or by explicit opt-in (`allowMockFallback`), because a
 * run that silently landed on the mock used to be indistinguishable from one
 * that reached a model, and consumers grew prediction code to tell them apart.
 *
 * `opts` carries the per-run model and per-org BYO keys; both fall back to the
 * host's env (model via the provider constructor's env default, keys above).
 */
export function selectProvider(preferred?: string | null, opts: ProviderSelection = {}): Provider {
  // undefined → the provider constructor's env-default model kicks in.
  const model = opts.model ?? undefined
  const resolution = resolve(preferred, opts)
  switch (resolution.kind) {
    case "cloud":
      switch (resolution.name) {
        case "anthropic":
          return new AnthropicProvider(resolution.key, model, opts.baseURLs?.anthropic)
        case "openai":
          return new OpenAIProvider(resolution.key, model, opts.baseURLs?.openai)
        case "openrouter":
          return new OpenRouterProvider(resolution.key, model, {}, opts.baseURLs?.openrouter)
      }
    // eslint-disable-next-line no-fallthrough -- the inner switch is exhaustive
    case "local":
      return new LocalProvider(
        resolution.baseURL,
        opts.credentials?.local ?? process.env.LOCAL_MODEL_API_KEY,
        model,
      )
    case "mock":
      // The mock is handed the full selection so it can self-document the
      // model + BYO key a real run WOULD have used.
      return new MockProvider(opts)
    case "missing":
      throw resolution.error
  }
}
