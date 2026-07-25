import { describe, it, expect, vi } from "vitest"
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { Agent, fetch as undiciFetch } from "undici"
import { httpFetch, assertSafeUrl, pinnedAgent, type FetchImpl, type Lookup } from "./http.js"

/** A resolver that always returns a public address (keeps tests off real DNS). */
const publicLookup: Lookup = async () => [{ address: "93.184.216.34", family: 4 }]

/** The TLS live test shells out to `openssl`; skip it gracefully where absent. */
const hasOpenssl = ((): boolean => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * Wrap a Response-returning mock as a `FetchImpl`. The unit tests don't exercise
 * the real undici dispatcher (no socket); they inject this so we can assert the
 * guard/redirect/timeout logic without touching the network. The pinning path
 * itself is covered by the live-server tests below.
 */
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchImpl {
  return impl as unknown as FetchImpl
}

describe("httpFetch", () => {
  it("rejects a host that is not in allowHosts", async () => {
    await expect(
      httpFetch({ url: "https://evil.example.com/x", allowHosts: ["api.good.com"] }),
    ).rejects.toThrow(/host not allowed/)
  })

  it("always refuses internal / link-local addresses (SSRF)", async () => {
    await expect(httpFetch({ url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(
      /internal/,
    )
    await expect(httpFetch({ url: "http://127.0.0.1:8080/" })).rejects.toThrow(/internal/)
    await expect(httpFetch({ url: "http://[::1]/" })).rejects.toThrow(/internal/)
  })

  it("re-validates redirect hops against allowHosts", async () => {
    // Allowed host responds with a redirect to a disallowed internal host.
    const fetchImpl = mockFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } }),
    )

    await expect(
      httpFetch({
        url: "https://api.good.com/start",
        allowHosts: ["api.good.com"],
        lookup: publicLookup,
        fetchImpl,
      }),
    ).rejects.toThrow(/host not allowed: evil.example.com/)
  })

  it("refuses a public hostname that resolves to an internal IP (DNS rebinding)", async () => {
    const fetchImpl = mockFetch(async () => new Response("ok"))
    const fetchSpy = vi.fn(fetchImpl)
    const rebindLookup: Lookup = async () => [{ address: "169.254.169.254", family: 4 }]

    await expect(
      httpFetch({
        url: "https://totally-public.example.com/x",
        lookup: rebindLookup,
        fetchImpl: fetchSpy,
      }),
    ).rejects.toThrow(/resolves to internal/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses an IPv4-mapped IPv6 internal address (::ffff:…)", async () => {
    const fetchImpl = mockFetch(async () => new Response("ok"))
    const fetchSpy = vi.fn(fetchImpl)
    const mappedLookup: Lookup = async () => [{ address: "::ffff:169.254.169.254", family: 6 }]

    await expect(
      httpFetch({
        url: "https://totally-public.example.com/x",
        lookup: mappedLookup,
        fetchImpl: fetchSpy,
      }),
    ).rejects.toThrow(/resolves to internal/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("caps the response body size", async () => {
    const big = "x".repeat(50)
    const fetchImpl = mockFetch(async () => new Response(big))

    await expect(
      httpFetch({ url: "https://api.good.com/x", maxBytes: 10, lookup: publicLookup, fetchImpl }),
    ).rejects.toThrow(/exceeds/)
  })

  it("aborts a hung request after the timeout (http timeout)", async () => {
    // A fetch that never resolves on its own — only the AbortController signal can
    // end it. undici fetch honours `signal`; we mirror that here.
    const fetchImpl = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
          }
        }),
    )
    const fetchSpy = vi.fn(fetchImpl)

    await expect(
      httpFetch({
        url: "https://api.good.com/x",
        timeoutMs: 10,
        lookup: publicLookup,
        fetchImpl: fetchSpy,
      }),
    ).rejects.toThrow(/http timeout/)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("aborts when headers arrive but the body stalls (http timeout)", async () => {
    // Headers resolve immediately, but the body stream never yields a chunk and
    // never closes — only the AbortController signal can end it. This is the
    // drip-feed case the body-read deadline must cover.
    const fetchImpl = mockFetch((_url, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal) {
            signal.addEventListener("abort", () =>
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
          }
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const fetchSpy = vi.fn(fetchImpl)

    await expect(
      httpFetch({
        url: "https://api.good.com/x",
        timeoutMs: 10,
        lookup: publicLookup,
        fetchImpl: fetchSpy,
      }),
    ).rejects.toThrow(/http timeout/)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe("assertSafeUrl returns the records to pin", () => {
  it("returns the resolved records for a DNS hostname (the set fetch will be pinned to)", async () => {
    const records = await assertSafeUrl("https://api.good.com/x", { lookup: publicLookup })
    expect(records).toEqual([{ address: "93.184.216.34", family: 4 }])
  })

  it("returns the literal IP for an IP-literal host (no DNS, pinned directly)", async () => {
    const v4 = await assertSafeUrl("http://93.184.216.34/x")
    expect(v4).toEqual([{ address: "93.184.216.34", family: 4 }])
    const v6 = await assertSafeUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/x")
    expect(v6).toEqual([{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }])
  })

  it("still rejects internal resolved addresses before returning any records", async () => {
    const rebindLookup: Lookup = async () => [{ address: "10.0.0.5", family: 4 }]
    await expect(
      assertSafeUrl("https://rebind.example.com/x", { lookup: rebindLookup }),
    ).rejects.toThrow(/resolves to internal/)
  })

  it("rejects a host that resolves to no records (nothing to pin)", async () => {
    const emptyLookup: Lookup = async () => []
    await expect(
      assertSafeUrl("https://no-records.example.com/x", { lookup: emptyLookup }),
    ).rejects.toThrow(/no DNS records/)
  })
})

/**
 * Live-server tests for the connection-pinning DISPATCHER: these use the REAL
 * undici `fetch` + the `pinnedAgent` dispatcher against loopback servers, so the
 * `Agent({ connect: { lookup } })` actually drives the socket. They prove that
 * (a) the connection goes to the pinned record even when the hostname would NOT
 * resolve via real DNS (so fetch can't re-resolve to a different IP), and (b) TLS
 * SNI/cert verification is preserved against the HOSTNAME, not the pinned IP, and
 * is never disabled.
 *
 * These exercise `pinnedAgent` directly (rather than via `httpFetch`) because the
 * SSRF guard — correctly — refuses loopback addresses, so a loopback test server
 * can't be reached through `httpFetch`'s guard. `pinnedAgent` is the exact unit
 * that closes the rebinding window, so testing it directly is the faithful check.
 */
describe("pinnedAgent connection pinning (live servers)", () => {
  it("connects to the pinned IP even when the hostname is non-resolvable (no re-resolution)", async () => {
    const server = http.createServer((_req, res) => res.end("pinned-ok"))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address() as AddressInfo
    const agent = pinnedAgent([{ address: "127.0.0.1", family: 4 }])
    try {
      // `*.invalid` never resolves via real DNS — the request can ONLY succeed
      // because the pinned record supplies 127.0.0.1. If fetch re-resolved the
      // hostname itself, this would fail with ENOTFOUND.
      const res = await undiciFetch(`http://pin-test.invalid:${port}/`, { dispatcher: agent })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("pinned-ok")
    } finally {
      await agent.close()
      server.close()
    }
  })

  it.skipIf(!hasOpenssl)(
    "verifies the TLS cert against the hostname (SNI preserved), not the pinned IP",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "http-pin-tls-"))
      const keyPath = join(dir, "key.pem")
      const certPath = join(dir, "cert.pem")
      try {
        // Self-signed cert for CN/SAN = pinned.test.
        execFileSync("openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=pinned.test",
          "-addext",
          "subjectAltName=DNS:pinned.test",
        ])
        const ca = readFileSync(certPath)
        const server = https.createServer({ key: readFileSync(keyPath), cert: ca }, (_req, res) =>
          res.end("tls-pinned-ok"),
        )
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
        const { port } = server.address() as AddressInfo
        try {
          // Pin to loopback and trust the self-signed CA (verification stays ON).
          // pinnedAgent uses undici's secure defaults; here we mirror its connect
          // config but add the test CA so the self-signed cert can be verified —
          // the lookup-pinning + hostname-derived servername behavior is identical.
          const pin = [{ address: "127.0.0.1", family: 4 }]
          // Mirror pinnedAgent's connect config, adding the test CA so the self-signed
          // cert verifies (verification stays ON). Both agents are closed in `finally`
          // so a failing assertion can't leak them.
          const trusting = new Agent({ connect: { ca, lookup: (_h, _o, cb) => cb(null, pin) } })
          const wrong = new Agent({ connect: { ca, lookup: (_h, _o, cb) => cb(null, pin) } })
          try {
            // Correct hostname → cert SAN matches → succeeds (connect is to the pinned IP).
            const ok = await undiciFetch(`https://pinned.test:${port}/`, { dispatcher: trusting })
            expect(ok.status).toBe(200)
            expect(await ok.text()).toBe("tls-pinned-ok")

            // Wrong hostname, same pinned IP and CA → cert SAN mismatch → MUST fail.
            // Proves verification is against the hostname (SNI), not the connected IP,
            // and is not disabled.
            await expect(
              undiciFetch(`https://wrong-name.test:${port}/`, { dispatcher: wrong }),
            ).rejects.toThrow()
          } finally {
            await trusting.close()
            await wrong.close()
          }
        } finally {
          server.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
