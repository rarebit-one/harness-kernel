import net from "node:net"
import dns from "node:dns/promises"
import { Agent, fetch as undiciFetch } from "undici"

/** Subset of `dns.lookup({ all: true })` we depend on — injectable for tests. */
export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>

const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true })

/**
 * The `fetch` implementation, injectable for tests. We use undici's OWN `fetch`
 * (not the global) because the global is Node's *bundled* undici, whose internal
 * handler interface is incompatible with a `dispatcher` built from the npm
 * `undici` package — mixing them throws `invalid onRequestStart method`. Pinning
 * the connection (see `pinnedAgent`) requires our dispatcher, so the matching
 * `fetch` must come from the same package.
 */
export type FetchImpl = typeof undiciFetch

export interface HttpFetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** When provided, EVERY request hop (including redirects) must be to a host in this list. */
  allowHosts?: string[]
  /** Cap on the response body; a larger response is rejected (memory-DoS guard). */
  maxBytes?: number
  /** Max redirects to follow. */
  maxRedirects?: number
  /**
   * Per-request timeout in milliseconds. Aborts the fetch (and applies afresh to
   * each redirect hop) so a hung endpoint can't stall the whole run. Defaults to
   * `RUNNER_HTTP_TIMEOUT_MS` if set, else 30s.
   */
  timeoutMs?: number
  /** DNS resolver (defaults to `dns.lookup`); injectable to test rebinding guards. */
  lookup?: Lookup
  /** `fetch` implementation (defaults to undici's `fetch`); injectable for tests. */
  fetchImpl?: FetchImpl
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const FALLBACK_TIMEOUT_MS = 30_000

/** Resolve the default per-request timeout from env, falling back to 30s. */
function defaultTimeoutMs(): number {
  const raw = Number(process.env.RUNNER_HTTP_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_TIMEOUT_MS
}

/** The validated IP records a hop may connect to, pinned so `fetch` can't re-resolve. */
type ValidatedRecords = Array<{ address: string; family: number }>

/**
 * SSRF guard for a single URL: refuse internal/loopback/link-local hosts (literal
 * or DNS-resolved), and — when `allowHosts` is set — require the host be on it.
 * Shared by httpFetch and the bundle downloader so both enforce the same policy.
 *
 * Returns the exact, already-validated address record(s) the host may connect to:
 * the resolved records for a DNS hostname, or the single literal for an IP host.
 * httpFetch PINS the connection to these (see `pinnedAgent`) so the socket reaches
 * the same IP the guard approved — closing the DNS-rebinding TOCTOU where `fetch`
 * would otherwise re-resolve to a different (internal) address. Callers that only
 * need the boolean verdict (e.g. the bundle downloader) can ignore the return.
 */
/**
 * Refuse a plaintext URL unless explicitly opted in.
 *
 * `assertSafeUrl` validated *who* it was talking to and never *how* — no
 * protocol check existed anywhere in this file. A guard that resolves DNS
 * carefully and then speaks plaintext is protecting a channel anyone on the
 * path can rewrite; for the snapshot download that meant a MITM could swap the
 * tarball that gets extracted and executed.
 *
 * Opt-in mirrors the existing `RUNNER_ALLOW_FILE_URLS` precedent: dev and test
 * rigs that genuinely need plaintext set it, production leaves it off. Resolved
 * per call so a changed env takes effect without a reload.
 *
 * `file:` is not handled here — `downloadToFile` gates it separately, before
 * any of this runs.
 */
export function assertSafeScheme(target: string | URL): void {
  const u = typeof target === "string" ? new URL(target) : target
  if (u.protocol === "https:") return
  if (process.env.RUNNER_ALLOW_INSECURE_URLS === "1") return
  throw new Error(
    `insecure scheme not allowed: ${u.protocol}//; set RUNNER_ALLOW_INSECURE_URLS=1 for local dev`,
  )
}

export async function assertSafeUrl(
  target: string,
  opts: { allowHosts?: string[]; lookup?: Lookup } = {},
): Promise<ValidatedRecords> {
  const { allowHosts, lookup = defaultLookup } = opts
  const u = new URL(target)
  if (isInternalHost(u.hostname)) throw new Error(`host not allowed (internal): ${u.hostname}`)
  // AFTER the internal-host check on purpose: an internal address should still
  // report as internal rather than as a scheme problem, because that is the
  // more specific fact and the one the caller acts on.
  assertSafeScheme(u)
  if (allowHosts && !allowHosts.includes(u.host)) throw new Error(`host not allowed: ${u.host}`)

  const literal = u.hostname.replace(/^\[|\]$/g, "") // URL.hostname keeps IPv6 brackets
  const literalVersion = net.isIP(literal)
  if (literalVersion !== 0) {
    // An IP literal: already classified as public above; pin to it directly.
    return [{ address: literal, family: literalVersion }]
  }

  const records = await lookup(u.hostname)
  if (records.length === 0) {
    // No records means there is nothing to pin; surface a clear guard error
    // rather than letting the pinned dispatcher fail later with a cryptic socket error.
    throw new Error(`host not allowed (no DNS records): ${u.hostname}`)
  }
  for (const { address } of records) {
    if (isInternalAddress(address)) {
      throw new Error(`host not allowed (resolves to internal): ${u.hostname} -> ${address}`)
    }
  }
  return records
}

/**
 * An undici dispatcher that PINS the connection to the already-validated IP(s).
 * Its `connect.lookup` ignores the hostname and returns ONLY the records the SSRF
 * guard approved, so the socket connects to the exact IP that was checked — a
 * hostile low-TTL resolver can't hand a different (internal) address to `fetch`.
 *
 * TLS correctness: we pin the *IP* via `lookup`, but undici still presents the
 * original hostname for SNI and certificate verification (its connector derives
 * `servername` from the request host, and `net/tls.connect` keeps `host` = the
 * hostname while using our lookup result only to choose the socket address). So
 * cert hostname checks are preserved and verification is NEVER disabled. We do
 * not set `rejectUnauthorized` — the secure default stands.
 *
 * Exported for tests: the pin + TLS-servername behavior is the security-critical
 * unit and is exercised directly against loopback servers.
 */
export function pinnedAgent(records: ValidatedRecords): Agent {
  return new Agent({
    connect: {
      // Node's `net.connect` calls lookup as `(hostname, { all: true }, cb)` and
      // expects the array form `cb(null, [{ address, family }])`. Return the pinned
      // records verbatim, ignoring `hostname` so no fresh DNS resolution happens.
      lookup: (_hostname, _options, callback) => {
        callback(null, records)
      },
    },
  })
}

/** A fetch hop plus the controls needed to bound its body read by the same timeout. */
interface TimedFetch {
  res: Awaited<ReturnType<FetchImpl>>
  /** Aborts the in-flight request/response (fires on the per-hop timeout). */
  controller: AbortController
  /** True once the timeout fired — lets the body reader report a clear timeout. */
  timedOut: () => boolean
  /** Stops the timer and closes the pinned dispatcher once the body is read/abandoned. */
  done: () => void
}

/**
 * Start a single fetch hop under an AbortController-backed timeout, PINNED to the
 * already-validated IP(s) via a per-hop undici dispatcher. The SAME
 * controller/timer must remain armed while the body is streamed (see
 * `readBodyCapped`), because `fetch` resolves once headers arrive — a server that
 * then drip-feeds the body would otherwise stall forever. On timeout the abort
 * surfaces as a clear `http timeout` error rather than the raw AbortError.
 *
 * A fresh dispatcher is built per hop (each hop is validated + pinned to its own
 * address) and closed in `done()` so connections aren't reused across hosts.
 */
async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  target: string,
  init: Parameters<FetchImpl>[1],
  records: ValidatedRecords,
  timeoutMs: number,
): Promise<TimedFetch> {
  const controller = new AbortController()
  const agent = pinnedAgent(records)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const closeAgent = () => {
    void agent.close().catch(() => {})
  }
  try {
    const res = await fetchImpl(target, { ...init, signal: controller.signal, dispatcher: agent })
    return {
      res,
      controller,
      timedOut: () => timedOut,
      done: () => {
        clearTimeout(timer)
        closeAgent()
      },
    }
  } catch (err) {
    clearTimeout(timer)
    closeAgent()
    if (timedOut) {
      throw new Error(`http timeout after ${timeoutMs}ms: ${target}`, { cause: err })
    }
    throw err
  }
}

/**
 * Thin wrapper over undici's `fetch`. A general-purpose primitive: domain
 * specific API logic belongs in user-repo code that calls this.
 *
 * SSRF guards: requests to internal/loopback/link-local addresses are ALWAYS
 * refused (e.g. cloud metadata at 169.254.169.254), and when `allowHosts` is set
 * the host must be on it. Redirects are followed manually so EACH hop is
 * re-validated (an allowed/public host could 30x to an internal one) AND pinned
 * (see below). The response body is always size-capped.
 *
 * DNS-rebinding TOCTOU is closed: each hop is validated, then the connection is
 * PINNED to the exact validated IP via a per-hop undici dispatcher (`pinnedAgent`).
 * `fetch` therefore cannot re-resolve the hostname to a different address between
 * the guard's check and the socket connect. TLS SNI/cert verification still uses
 * the original hostname (see `pinnedAgent`). Prefer an explicit `allowHosts`
 * allowlist for untrusted callers regardless.
 */
export async function httpFetch(options: HttpFetchOptions): Promise<HttpResponse> {
  const {
    url,
    method = "GET",
    headers,
    body,
    allowHosts,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = defaultTimeoutMs(),
    lookup = defaultLookup,
    fetchImpl = undiciFetch,
  } = options

  const assertSafe = (target: string): Promise<ValidatedRecords> =>
    assertSafeUrl(target, { allowHosts, lookup })

  let currentUrl = url
  let records = await assertSafe(currentUrl)
  let hop = await fetchWithTimeout(
    fetchImpl,
    currentUrl,
    { method, headers, body, redirect: "manual" },
    records,
    timeoutMs,
  )

  let hops = 0
  while (hop.res.status >= 300 && hop.res.status < 400 && hop.res.headers.has("location")) {
    // Cancel the unread redirect body so the socket isn't left half-open before
    // we close this hop's dispatcher and follow the Location.
    await hop.res.body?.cancel().catch(() => {})
    hop.done() // disarm this hop's timer + close its pinned dispatcher before following the redirect
    if (hops >= maxRedirects) throw new Error("too many redirects")
    const next = new URL(hop.res.headers.get("location") as string, currentUrl).toString()
    records = await assertSafe(next) // validate AND re-pin the new hop's address
    currentUrl = next
    hop = await fetchWithTimeout(
      fetchImpl,
      currentUrl,
      { method, headers, redirect: "manual" },
      records,
      timeoutMs,
    )
    hops += 1
  }

  const res = hop.res
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  // The hop's timer is still armed, so the body read below is bounded by the same
  // per-request timeout: a stalled body trips `hop.timedOut()` → `http timeout`.
  return {
    status: res.status,
    headers: responseHeaders,
    body: await readBodyCapped(hop, currentUrl, maxBytes),
  }
}

/**
 * Read the body, aborting if it exceeds `maxBytes` OR if the hop's timeout fires
 * mid-stream. Bounding the body (not just time-to-headers) means a server that
 * sends headers then drip-feeds the body still can't stall the run.
 */
async function readBodyCapped(hop: TimedFetch, target: string, maxBytes: number): Promise<string> {
  const { res, controller, timedOut, done } = hop
  try {
    if (!res.body) return await res.text()

    // undici's ReadableStream types are non-generic, so the reader yields `any`;
    // fetch response bodies are always byte streams.
    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error(`response exceeds ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    } catch (err) {
      // The timer aborts the controller, which surfaces here as an abort/read
      // error — translate it to the same clear timeout message as the header phase.
      if (timedOut() || controller.signal.aborted) {
        throw new Error(`http timeout: ${target}`, { cause: err })
      }
      throw err
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    done()
  }
}

/** True for hostnames/IP-literals that point at the host or a private network. */
function isInternalHost(host: string): boolean {
  if (host === "localhost") return true
  const bare = host.replace(/^\[|\]$/g, "") // URL.hostname keeps IPv6 brackets
  const version = net.isIP(bare)
  if (version === 4) return isInternalV4(bare)
  if (version === 6) return isInternalV6(bare)
  return false // a regular hostname — not an IP literal we can classify here
}

/** Classify a resolved IP address string (v4 or v6) as internal. */
function isInternalAddress(ip: string): boolean {
  const version = net.isIP(ip)
  if (version === 4) return isInternalV4(ip)
  if (version === 6) return isInternalV6(ip)
  return false
}

function isInternalV4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map(Number)
  if (a === 0 || a === 127 || a === 10) return true // unspecified, loopback, private
  if (a === 169 && b === 254) return true // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (RFC 6598)
  return false
}

function isInternalV6(ip: string): boolean {
  const x = ip.toLowerCase().replace(/^\[|\]$/g, "")
  // IPv4-mapped (::ffff:a.b.c.d) maps onto a v4 address — classify by the embedded v4.
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isInternalV4(mapped[1])
  return (
    x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80")
  )
}
