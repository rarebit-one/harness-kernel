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
 *
 * Redirects are not followed here: unless the transport asks otherwise, the
 * request goes out with `redirect: "manual"`, so a 3xx comes back to the
 * transport, which follows only a same-origin one. A credential header that is
 * not `Authorization` (which fetch strips on a cross-origin hop) would
 * otherwise be forwarded to whatever origin the server names.
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
  ): Promise<Headers> => {
    let resolved: unknown
    try {
      resolved = await resolve({ connector, refresh, ...(signal ? { signal } : {}) })
    } catch (err) {
      throw new ConnectorAuthError(connector, "function failed", err)
    }
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw new ConnectorAuthError(connector, "function returned no headers object")
    }
    // Nothing is reported until every value checks out, so a bad return names
    // only the header, never a value. `Headers` rejects a value holding a line
    // break or NUL with a TypeError that quotes it, so that error is replaced
    // and not kept as the cause.
    const headers = new Headers()
    for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new ConnectorAuthError(connector, `function returned a non-string ${key} header`)
      }
      try {
        headers.set(key, value)
      } catch {
        throw new ConnectorAuthError(connector, `function returned an invalid ${key} header`)
      }
    }
    // What is reported is what goes on the wire: `Headers` trims the value, and
    // an echo of the trimmed credential must still be masked.
    headers.forEach((value) => reportCredential(value, onSecret))
    return headers
  }

  const send = async (url: string | URL, init: RequestInit | undefined, refresh: boolean) => {
    const headers = new Headers(init?.headers)
    ;(await headersFor(refresh, init?.signal)).forEach((value, key) => headers.set(key, value))
    return base(url, { ...init, headers, redirect: init?.redirect ?? "manual" })
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
