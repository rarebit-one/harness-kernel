import { describe, it, expect } from "vitest"
import { authHeadersFetch, ConnectorAuthError, reportCredential } from "./auth.js"
import type { ConnectorAuthRequest } from "../types.js"

/** A fetch that records each request's headers and answers from `statuses` in turn. */
function recordingFetch(statuses: number[]) {
  const seen: Headers[] = []
  const fetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    seen.push(new Headers(init?.headers))
    return new Response("{}", { status: statuses[seen.length - 1] ?? 200 })
  }
  return { fetch, seen }
}

describe("authHeadersFetch", () => {
  it("sets the function's headers on every request, asking each time", async () => {
    const { fetch, seen } = recordingFetch([200, 200])
    let n = 0
    const wrapped = authHeadersFetch(
      "crm",
      () => ({ Authorization: `Bearer token-${++n}-abcdef` }),
      () => {},
      fetch,
    )

    await wrapped("http://server/mcp", { method: "POST", headers: { accept: "a" }, body: "{}" })
    await wrapped("http://server/mcp", { method: "POST", body: "{}" })

    expect(seen.map((h) => h.get("authorization"))).toEqual([
      "Bearer token-1-abcdef",
      "Bearer token-2-abcdef",
    ])
    // The transport's own headers are kept.
    expect(seen[0]?.get("accept")).toBe("a")
  })

  it("asks again with refresh: true after a 401 and retries the request once", async () => {
    const { fetch, seen } = recordingFetch([401, 200])
    const asked: ConnectorAuthRequest[] = []
    const wrapped = authHeadersFetch(
      "crm",
      (req) => {
        asked.push(req)
        return { Authorization: req.refresh ? "Bearer fresh-token" : "Bearer stale-token" }
      },
      () => {},
      fetch,
    )

    const res = await wrapped("http://server/mcp", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(asked.map((r) => [r.connector, r.refresh])).toEqual([
      ["crm", false],
      ["crm", true],
    ])
    expect(seen.map((h) => h.get("authorization"))).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ])
  })

  it("returns a second 401 as it is rather than looping", async () => {
    const { fetch, seen } = recordingFetch([401, 401, 200])
    const wrapped = authHeadersFetch(
      "crm",
      () => ({ Authorization: "Bearer x" }),
      () => {},
      fetch,
    )

    const res = await wrapped("http://server/mcp", { method: "POST", body: "{}" })

    expect(res.status).toBe(401)
    expect(seen).toHaveLength(2)
  })

  it("does not retry a request whose body cannot be sent twice", async () => {
    const { fetch, seen } = recordingFetch([401, 200])
    const wrapped = authHeadersFetch(
      "crm",
      () => ({ Authorization: "Bearer x" }),
      () => {},
      fetch,
    )

    const res = await wrapped("http://server/mcp", {
      method: "POST",
      body: new ReadableStream(),
    })

    expect(res.status).toBe(401)
    expect(seen).toHaveLength(1)
  })

  it("reports every value, and the credential after its scheme, before sending", async () => {
    const { fetch } = recordingFetch([200])
    const reported: string[] = []
    const wrapped = authHeadersFetch(
      "crm",
      async () => ({ Authorization: "Bearer abc123def", "X-Api-Key": "key-987654" }),
      (v) => reported.push(v),
      fetch,
    )

    await wrapped("http://server/mcp", { method: "GET" })

    expect(reported).toEqual(["Bearer abc123def", "abc123def", "key-987654"])
  })

  it("fails loud, naming the connector and not the error, when the function throws", async () => {
    const { fetch, seen } = recordingFetch([200])
    const wrapped = authHeadersFetch(
      "crm",
      () => {
        throw new Error("vault said no for tok_live_secret_value")
      },
      () => {},
      fetch,
    )

    const err = await wrapped("http://server/mcp", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ConnectorAuthError)
    expect((err as Error).message).toBe("connector crm: auth headers function failed")
    expect((err as Error).message).not.toContain("tok_live_secret_value")
    expect(seen).toHaveLength(0)
  })

  it("fails loud on a return that is not a map of strings, naming only the header", async () => {
    const { fetch } = recordingFetch([200])
    const reported: string[] = []
    const bad = authHeadersFetch(
      "crm",
      () =>
        ({ Authorization: "Bearer abcdefgh", "X-Count": 3 }) as unknown as Record<string, string>,
      (v) => reported.push(v),
      fetch,
    )
    const none = authHeadersFetch(
      "crm",
      () => undefined as unknown as Record<string, string>,
      () => {},
      fetch,
    )

    await expect(bad("http://server/mcp")).rejects.toThrow(
      "connector crm: auth headers function returned a non-string X-Count header",
    )
    await expect(none("http://server/mcp")).rejects.toThrow(
      "connector crm: auth headers function returned no headers object",
    )
    expect(reported).toEqual([])
  })
})

describe("reportCredential", () => {
  it("reports a bare value once and a scheme-prefixed value with its credential", () => {
    const seen: string[] = []
    reportCredential("tok_only_value", (v) => seen.push(v))
    reportCredential("Basic dXNlcjpwYXNz", (v) => seen.push(v))
    expect(seen).toEqual(["tok_only_value", "Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"])
  })
})
