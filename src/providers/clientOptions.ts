/**
 * Shared resolution of provider-SDK robustness knobs. Both the Anthropic and
 * OpenAI SDKs accept `timeout` (per-request, ms) and `maxRetries` in their
 * constructor and handle transient 429/5xx/network retries with backoff
 * themselves — we just supply sensible, env-overridable defaults. `maxTokens`
 * is the per-request completion cap both providers send with each call.
 */

const FALLBACK_TIMEOUT_MS = 60_000
const FALLBACK_MAX_RETRIES = 2
const FALLBACK_MAX_TOKENS = 4096

/** Per-request provider timeout in ms (`RUNNER_PROVIDER_TIMEOUT_MS`, default 60s). */
export function providerTimeoutMs(): number {
  const raw = Number(process.env.RUNNER_PROVIDER_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_TIMEOUT_MS
}

/** SDK auto-retry count for transient failures (`RUNNER_PROVIDER_MAX_RETRIES`, default 2). */
export function providerMaxRetries(): number {
  const raw = Number(process.env.RUNNER_PROVIDER_MAX_RETRIES)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : FALLBACK_MAX_RETRIES
}

/** Per-request completion token cap (`RUNNER_MAX_TOKENS`, default 4096). */
export function maxTokens(): number {
  const raw = Number(process.env.RUNNER_MAX_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FALLBACK_MAX_TOKENS
}
