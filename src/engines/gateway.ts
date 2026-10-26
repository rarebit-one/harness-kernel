import type { RunSpec } from "./types.js"

/**
 * A credential gateway: a host-side service that holds the run's real provider
 * keys and injects them on the way out, so the run itself only ever holds a
 * short-lived, attempt-bound run token.
 *
 * The mechanism is base-URL redirection, never interception: every supported
 * harness and adapter honours a provider base URL, so a run is pointed at
 * `<route>` with the run token in place of the API key, and the gateway swaps
 * in the real key (and enforces its own budget) before forwarding. No CA, no
 * TLS termination inside the sandbox.
 *
 * When a spec carries one, no engine puts a raw provider credential — the
 * run's BYO keys or the host's own env keys — anywhere a harness can read it.
 */
export interface RunGateway {
  /** The gateway's base URL; a provider's default route is `<baseUrl>/p/<provider>`. */
  baseUrl: string
  /** The attempt-bound token the gateway authenticates the run with. The only credential the run holds. */
  runToken: string
  /** Per-provider base URLs, overriding the default route. */
  routes?: Partial<Record<GatewayProvider, string>>
}

export const GATEWAY_PROVIDERS = ["anthropic", "openai", "openrouter"] as const
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number]

/** The env var each provider's harness reads its base URL and key from. */
const PROVIDER_ENV: Record<GatewayProvider, { baseUrl: string; key: string }> = {
  anthropic: { baseUrl: "ANTHROPIC_BASE_URL", key: "ANTHROPIC_API_KEY" },
  openai: { baseUrl: "OPENAI_BASE_URL", key: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "OPENROUTER_BASE_URL", key: "OPENROUTER_API_KEY" },
}

/**
 * Host env prefixes a harness must NOT inherit while a gateway is in use: a
 * host `ANTHROPIC_BASE_URL` would route around the gateway, and a header or
 * config var under these prefixes can carry a credential whose name the
 * deny-list cannot spot (`ANTHROPIC_CUSTOM_HEADERS`).
 */
export const GATEWAY_SHADOWED_PREFIXES = ["ANTHROPIC_", "OPENAI_", "OPENROUTER_"] as const

/** The base URL a provider is reached through. */
export function gatewayRoute(gateway: RunGateway, provider: GatewayProvider): string {
  return gateway.routes?.[provider] ?? `${gateway.baseUrl.replace(/\/+$/, "")}/p/${provider}`
}

/**
 * The env that points a harness at the gateway for each of `providers`: the
 * route as its base URL and the run token as its key. This is what a harness
 * gets INSTEAD of a credential.
 */
export function gatewayEnv(
  gateway: RunGateway,
  providers: readonly GatewayProvider[] = GATEWAY_PROVIDERS,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const provider of providers) {
    env[PROVIDER_ENV[provider].baseUrl] = gatewayRoute(gateway, provider)
    env[PROVIDER_ENV[provider].key] = gateway.runToken
  }
  return env
}

/** Drop the prefixes a gateway shadows from a harness's inherit list. */
export function withoutShadowed(prefixes: readonly string[]): string[] {
  return prefixes.filter((p) => !GATEWAY_SHADOWED_PREFIXES.some((s) => p.startsWith(s)))
}

/**
 * Why the spec's gateway cannot be used, or `undefined` when it can (or there
 * is none). A malformed gateway is refused rather than ignored: ignoring it
 * would fall back to raw credentials, which is the thing it exists to stop.
 */
export function gatewayProblem(spec: Pick<RunSpec, "gateway">): string | undefined {
  const gateway = spec.gateway
  if (gateway === undefined) return undefined
  if (typeof gateway.runToken !== "string" || gateway.runToken === "") {
    return "gateway has no run token"
  }
  const urls: Array<[string, unknown]> = [
    ["baseUrl", gateway.baseUrl],
    ...Object.entries(gateway.routes ?? {}).map(([p, url]): [string, unknown] => [
      `routes.${p}`,
      url,
    ]),
  ]
  for (const [field, url] of urls) {
    if (typeof url !== "string" || !/^https?:\/\/[^/\s]+/.test(url)) {
      return `gateway ${field} is not an http(s) URL`
    }
  }
  for (const provider of Object.keys(gateway.routes ?? {})) {
    if (!(GATEWAY_PROVIDERS as readonly string[]).includes(provider)) {
      return `gateway routes a provider this kernel does not know: ${provider}`
    }
  }
  return undefined
}

/**
 * The refusal a microVM lane relies on: a run the caller placed on `vm`
 * isolation must not carry raw model credentials into the
 * guest. It reaches models through a gateway or not at all.
 *
 * "Raw" is any non-empty `provider.credentials` slot, and any of `hostKeys`
 * (the env keys this engine would otherwise fall back to) set on the host. The
 * reason names the slots, never their values. A run with a gateway passes: its
 * engine sends the run token instead, whatever the payload carried.
 */
export function refuseRawCredentialsInVm(
  engine: string,
  spec: Pick<RunSpec, "isolation" | "gateway" | "provider">,
  hostKeys: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { ok: false; reason: string } | undefined {
  if (spec.isolation !== "vm" || spec.gateway !== undefined) return undefined
  const raw = [
    ...Object.entries(spec.provider.credentials ?? {})
      .filter(([, value]) => typeof value === "string" && value !== "")
      .map(([slot]) => `provider.credentials.${slot}`),
    ...hostKeys.filter((key) => Boolean(env[key])).map((key) => `host ${key}`),
  ]
  if (raw.length === 0) return undefined
  return {
    ok: false,
    reason:
      `${engine} engine refuses a vm run holding raw model credentials (${raw.join(", ")}); ` +
      "route it through a credential gateway (RunSpec.gateway) instead",
  }
}

/**
 * The other half of the microVM rule: credentials the guest would hold in the
 * clear that are NOT model keys. A gateway cannot inject these, so they are
 * "exposed" — the run's `secrets` (they become the agent's env), and any
 * connector credential the harness would carry itself (a bearer `auth.token`,
 * or `headers` / `env` values a caller's connector shape adds).
 *
 * Under `vm` they are refused unless the spec says
 * `exposedCredentials: "allowed"`, which only the caller's policy may set
 * (the owner has not decided when exposed credentials are acceptable in a
 * microVM, so the default is refuse). A connector whose token IS the
 * gateway's run token is not exposed: that is a connector routed through the
 * gateway, which injects the real credential host-side. The reason names
 * secrets and connectors, never values.
 */
export function refuseExposedCredentialsInVm(
  engine: string,
  spec: Pick<RunSpec, "isolation" | "gateway" | "secrets" | "connectors" | "exposedCredentials">,
): { ok: false; reason: string } | undefined {
  if (spec.isolation !== "vm" || spec.exposedCredentials === "allowed") return undefined
  const runToken = spec.gateway?.runToken
  const exposed = [
    ...Object.entries(spec.secrets ?? {})
      .filter(([, value]) => typeof value === "string" && value !== "")
      .map(([name]) => `secret ${name}`),
    ...(spec.connectors ?? []).flatMap((connector) => {
      const found: string[] = []
      const token = connector.auth?.token
      if (typeof token === "string" && token !== "" && token !== runToken) {
        found.push(`connector ${connector.name} auth.token`)
      }
      // Not part of ConnectorConfig, but a caller's connector may carry them,
      // and whatever is there reaches the harness.
      const extra = connector as unknown as { headers?: unknown; env?: unknown }
      for (const field of ["headers", "env"] as const) {
        const values = extra[field]
        if (
          values &&
          typeof values === "object" &&
          Object.values(values).some((v) => v !== "" && v != null)
        ) {
          found.push(`connector ${connector.name} ${field}`)
        }
      }
      return found
    }),
  ]
  if (exposed.length === 0) return undefined
  return {
    ok: false,
    reason:
      `${engine} engine refuses a vm run holding exposed credentials (${exposed.join(", ")}); ` +
      'they reach the guest in the clear, so they need exposedCredentials: "allowed" from policy',
  }
}

/** Every credential refusal a `vm` run gets: raw model keys first, then exposed credentials. */
export function refuseCredentialsInVm(
  engine: string,
  spec: Pick<
    RunSpec,
    "isolation" | "gateway" | "provider" | "secrets" | "connectors" | "exposedCredentials"
  >,
  hostKeys: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { ok: false; reason: string } | undefined {
  return (
    refuseRawCredentialsInVm(engine, spec, hostKeys, env) ??
    refuseExposedCredentialsInVm(engine, spec)
  )
}

/** The refusal for a spec whose gateway is unusable, in `supports()` shape. */
export function refuseBadGateway(
  engine: string,
  spec: Pick<RunSpec, "gateway">,
): { ok: false; reason: string } | undefined {
  const problem = gatewayProblem(spec)
  return problem
    ? { ok: false, reason: `${engine} engine cannot use this run's gateway: ${problem}` }
    : undefined
}
