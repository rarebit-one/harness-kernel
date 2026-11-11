import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ConnectorAuthHeaders } from "../types.js"

/**
 * A connector's auth headers function threw or returned something unusable.
 * The message names the connector and never the function's error, which can
 * quote the credential it failed to produce; that error is the `cause`, for
 * the caller's own code and never sent to the model.
 */
export class ConnectorAuthError extends Error {
  constructor(connector: string, detail: string, cause?: unknown) {
    super(`connector ${connector}: auth headers ${detail}`, cause ? { cause } : undefined)
    this.name = "ConnectorAuthError"
  }
}

/**
 * Hand every secret part of a header value to `onSecret`: the whole value, and
 * the credential after an auth scheme (`Bearer abc` also yields `abc`), so a
 * server or tool echoing the bare token is masked too.
 */
export function reportCredential(value: string, onSecret: (value: string) => void): void {
  onSecret(value)
  const scheme = /^[A-Za-z][\w.+-]*\s+(\S.*)$/.exec(value)
  if (scheme?.[1]) onSecret(scheme[1])
}

/**
 * A fetch that sets `resolve`'s headers on every request, so a credential that
 * rotates during a run is picked up by the next request. A 401 asks `resolve`
 * again with `refresh: true` and sends the request once more; a second 401 is
 * returned as it is, for the transport to fail on. A request whose body cannot
 * be sent twice (a stream) is not retried.
 */
export function authHeadersFetch(
  connector: string,
  resolve: ConnectorAuthHeaders,
  onSecret: (value: string) => void,
  base: FetchLike = fetch,
): FetchLike {
  const headersFor = async (
    refresh: boolean,
    signal: AbortSignal | null | undefined,
  ): Promise<Record<string, string>> => {
    let resolved: unknown
    try {
      resolved = await resolve({ connector, refresh, ...(signal ? { signal } : {}) })
    } catch (err) {
      throw new ConnectorAuthError(connector, "function failed", err)
    }
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw new ConnectorAuthError(connector, "function returned no headers object")
    }
    const entries = Object.entries(resolved as Record<string, unknown>)
    // Nothing is reported until every value checks out, so a bad return names
    // only the header, never a value.
    const bad = entries.find(([, value]) => typeof value !== "string")
    if (bad) {
      throw new ConnectorAuthError(connector, `function returned a non-string ${bad[0]} header`)
    }
    for (const [, value] of entries) reportCredential(value as string, onSecret)
    return resolved as Record<string, string>
  }

  const send = async (url: string | URL, init: RequestInit | undefined, refresh: boolean) => {
    const headers = new Headers(init?.headers)
    for (const [key, value] of Object.entries(await headersFor(refresh, init?.signal))) {
      headers.set(key, value)
    }
    return base(url, { ...init, headers })
  }

  return async (url, init) => {
    const first = await send(url, init, false)
    const body = init?.body
    const replayable = body === undefined || body === null || typeof body === "string"
    if (first.status !== 401 || !replayable) return first
    await first.body?.cancel().catch(() => {})
    return send(url, init, true)
  }
}
