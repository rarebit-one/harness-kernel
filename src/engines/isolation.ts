/**
 * Isolation: how strongly the process running an engine is separated from
 * every other run on the same host.
 *
 * An out-of-process engine (Claude Code, Codex, an ACP agent) hands the run to a
 * vendor harness with its own shell and the whole filesystem, and approves every
 * action itself. The only safety boundary such a run has is the box it runs in.
 * So these engines refuse to run unless BOTH of these assert at least
 * `container` isolation:
 *
 *   - the caller, through {@link RunSpec.isolation} (what the dispatcher placed
 *     the run on), and
 *   - the host process, through the `RUNNER_ISOLATION` env var, set by the
 *     process's own entrypoint and never by a payload.
 *
 * The weaker of the two wins. A payload that claims `vm` while the process says
 * `none` is a shared host, and a process that says `vm` cannot vouch for a
 * payload that never asked. An unrecognised or absent value counts as `none`.
 */

/** Weakest first: one shared process, a container per run, a microVM per run. */
export const ISOLATION_LEVELS = ["none", "container", "vm"] as const
export type Isolation = (typeof ISOLATION_LEVELS)[number]

/** The weakest level an out-of-process engine will run under. */
const MINIMUM: Isolation = "container"

function parse(value: unknown): Isolation {
  return (ISOLATION_LEVELS as readonly unknown[]).includes(value) ? (value as Isolation) : "none"
}

function rank(level: Isolation): number {
  return ISOLATION_LEVELS.indexOf(level)
}

/** The isolation a run actually has: the weaker of the caller's and the host's claim. */
export function effectiveIsolation(
  spec: { isolation?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Isolation {
  const claimed = parse(spec.isolation)
  const host = parse(env.RUNNER_ISOLATION)
  return rank(claimed) <= rank(host) ? claimed : host
}

/**
 * The `supports()` refusal an out-of-process engine gives a run without at
 * least container isolation, or `undefined` when the run has it.
 */
export function refuseUnisolated(
  engine: string,
  spec: { isolation?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): { ok: false; reason: string } | undefined {
  const effective = effectiveIsolation(spec, env)
  if (rank(effective) >= rank(MINIMUM)) return undefined
  return {
    ok: false,
    reason:
      `${engine} engine requires at least ${MINIMUM} isolation, but this run has ${effective} ` +
      `(run: ${parse(spec.isolation)}, host RUNNER_ISOLATION: ${parse(env.RUNNER_ISOLATION)})`,
  }
}

/**
 * Host env vars a vendor harness may inherit regardless of engine: what a
 * process needs to find binaries, write temp files, pick a locale, trust the
 * host's CA bundle and reach the network through the host's proxy. Anything
 * else the host process holds (its own credentials, callback tokens, the run id)
 * stays with the host.
 */
const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const

/** Prefixes every harness may inherit: locale and XDG base-directory settings. */
const BASE_PREFIXES = ["LC_", "XDG_"] as const

/**
 * A name that looks like it holds a credential. A prefix match never passes one
 * of these (`ANTHROPIC_API_KEY`, `OPENAI_ADMIN_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`);
 * the one provider key an engine needs arrives through `extra` instead. This is
 * a best-effort deny-list inside an allow-list: it cannot spot a secret whose
 * name carries none of these words (`*_DSN`, `*_DB_URL`), so keep prefixes
 * narrow. HEADER is on it because a custom-headers var
 * (`ANTHROPIC_CUSTOM_HEADERS`) routinely carries an `x-api-key` or bearer.
 */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|HEADER/i

/**
 * The environment to spawn a vendor harness with: the base allowlist, any host
 * var starting with one of `prefixes` (the harness's own configuration, e.g.
 * `ANTHROPIC_BASE_URL`) that does not look like a credential, and then `extra`,
 * which always wins and is the only way a credential reaches the harness. Never
 * the host's whole environment.
 */
export function childEnv(
  prefixes: readonly string[],
  extra: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  const allowedPrefixes = [...BASE_PREFIXES, ...prefixes]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (
      (BASE_ENV as readonly string[]).includes(key) ||
      (allowedPrefixes.some((p) => key.startsWith(p)) && !CREDENTIAL_NAME.test(key))
    ) {
      out[key] = value
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
