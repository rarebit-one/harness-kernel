import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { authHeadersFetch, ConnectorAuthError, reportCredential } from "./auth.js"
import { connectMcp } from "./mcpClient.js"
import { MASKED_SECRET, secretMaskSet } from "../secrets.js"
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

describe("authHeadersFetch on the wire", () => {
  // Two loopback servers on different ports are two origins.
  let target: Server
  let redirector: Server
  let targetUrl = ""
  let redirectUrl = ""
  const seen: IncomingHttpHeaders[] = []

  beforeAll(async () => {
    target = createServer((req, res) => {
      seen.push(req.headers)
      res.end("ok")
    })
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/mcp`
    redirector = createServer((_req, res) => {
      res.writeHead(307, { location: targetUrl }).end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve))
    redirectUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/mcp`
  })

  afterAll(async () => {
    await new Promise((resolve) => target.close(resolve))
    await new Promise((resolve) => redirector.close(resolve))
  })

  it("hands a cross-origin redirect back instead of following it with the credentials", async () => {
    seen.length = 0
    // Called the way a transport that sets no redirect mode calls it.
    const wrapped = authHeadersFetch(
      "crm",
      () => ({ Authorization: "Bearer bearer-secret-1", "X-Api-Key": "api-key-secret-1" }),
      () => {},
    )

    const res = await wrapped(redirectUrl, { method: "POST", body: "{}" })

    expect(res.status).toBe(307)
    expect(seen).toEqual([])
  })

  it("names an invalid header value by header only, at the call and at connect", async () => {
    const headers = () => ({ Authorization: "Bearer bad\nsecret-value-xyz" })
    const err = await authHeadersFetch("crm", headers, () => {})(targetUrl, {
      method: "POST",
      body: "{}",
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConnectorAuthError)
    expect((err as Error).message).toBe(
      "connector crm: auth headers function returned an invalid Authorization header",
    )
    expect((err as Error).cause).toBeUndefined()

    const atConnect = await connectMcp({
      name: "crm",
      kind: "mcp",
      transport: "streamable_http",
      endpoint: targetUrl,
      auth: { type: "bearer", headers },
    }).catch((e: unknown) => e)
    expect((atConnect as Error).message).not.toContain("secret-value-xyz")
    expect((atConnect as Error).message).toContain("invalid Authorization header")
  })

  it("masks the trimmed credential that actually goes on the wire", async () => {
    seen.length = 0
    const secrets = secretMaskSet()
    const wrapped = authHeadersFetch(
      "crm",
      () => ({ Authorization: "Bearer trailing-token-abc " }),
      secrets.add,
    )

    await wrapped(targetUrl, { method: "POST", body: "{}" })

    expect(seen[0]?.authorization).toBe("Bearer trailing-token-abc")
    expect(secrets.mask("server echoed trailing-token-abc")).toBe(`server echoed ${MASKED_SECRET}`)
  })
})
