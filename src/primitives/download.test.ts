import { describe, it, expect, vi, afterEach } from "vitest"
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { downloadToFile } from "./download.js"

/** Resolver that keeps the SSRF guard off real DNS by claiming a public IP. */
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]

/** A Response whose body streams the given bytes. */
function streamResponse(bytes: Uint8Array, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, { status })
}

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dl-test-"))
  return path.join(dir, "out.bin")
}

describe("downloadToFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("copies a co-located file:// URL when RUNNER_ALLOW_FILE_URLS=1 (local-dev handoff)", async () => {
    vi.stubEnv("RUNNER_ALLOW_FILE_URLS", "1")
    const src = path.join(await mkdtemp(path.join(tmpdir(), "dl-src-")), "snap.tar.gz")
    const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]) // gzip-ish magic + payload
    await writeFile(src, bytes)
    const dest = await tmpFile()

    // No fetch involved — file:// bypasses the network + SSRF guard entirely.
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await downloadToFile(pathToFileURL(src).href, dest)

    expect(new Uint8Array(await readFile(dest))).toEqual(bytes)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a file:// URL when RUNNER_ALLOW_FILE_URLS is unset (prod default)", async () => {
    vi.stubEnv("RUNNER_ALLOW_FILE_URLS", "")
    await expect(downloadToFile("file:///etc/passwd", await tmpFile())).rejects.toThrow(/disabled/)
  })

  it("streams a binary body to disk", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]) // includes non-UTF8 bytes
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(bytes)),
    )
    const dest = await tmpFile()

    await downloadToFile("https://spaces.example.com/run.bundle", dest, { lookup: publicLookup })

    expect(new Uint8Array(await readFile(dest))).toEqual(bytes)
    await rm(path.dirname(dest), { recursive: true, force: true })
  })

  it("refuses an internal host (SSRF) and writes nothing", async () => {
    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1])))
    vi.stubGlobal("fetch", fetchMock)
    const dest = await tmpFile()

    await expect(downloadToFile("https://169.254.169.254/latest/meta-data", dest)).rejects.toThrow(
      /internal/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(readFile(dest)).rejects.toThrow()
  })

  it("refuses a public host that resolves to an internal IP (DNS rebinding)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(new Uint8Array([1]))),
    )
    const rebind = async () => [{ address: "10.0.0.5", family: 4 }]
    await expect(
      downloadToFile("https://evil.example.com/x.bundle", await tmpFile(), { lookup: rebind }),
    ).rejects.toThrow(/resolves to internal/)
  })

  it("still refuses an internal host when RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS is absent (locks the default)", async () => {
    delete process.env.RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(new Uint8Array([1]))),
    )
    await expect(
      downloadToFile("https://minio:9000/bucket/x.tar.gz", await tmpFile(), {
        lookup: async () => [{ address: "10.89.10.3", family: 4 }],
      }),
    ).rejects.toThrow(/resolves to internal/)
  })

  it("refuses plaintext EVEN WITH RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS=1", async () => {
    // The invariant this fix exists for. Trusting a private HOST is not the same
    // concession as trusting a plaintext TRANSPORT, and setting the private-hosts
    // flag used to skip assertSafeUrl wholesale — silently taking the scheme
    // check with it. This tarball is extracted and executed, so a MITM on that
    // hop is code execution in the runner.
    vi.stubEnv("RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS", "1")
    vi.stubEnv("RUNNER_ALLOW_INSECURE_URLS", "")
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    await expect(
      downloadToFile("http://minio:9000/bucket/x.tar.gz", await tmpFile()),
    ).rejects.toThrow(/insecure scheme/)
    // Refused BEFORE any network call — nothing was fetched at all.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses a plaintext REDIRECT HOP, not just the first request", async () => {
    // Per-hop, because a https:// URL that redirects to http:// downgrades the
    // very transport the first check approved.
    vi.stubEnv("RUNNER_ALLOW_INSECURE_URLS", "")
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "http://evil.example/x" } }),
        ),
    )

    await expect(
      downloadToFile("https://good.example/x.tar.gz", await tmpFile(), { lookup: publicLookup }),
    ).rejects.toThrow(/insecure scheme/)
  })

  it("allows an internal host when RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS=1 (private object-store opt-in)", async () => {
    vi.stubEnv("RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS", "1")
    const bytes = new Uint8Array([7, 8])
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(bytes)),
    )
    const dest = await tmpFile()

    await downloadToFile("https://minio:9000/bucket/x.tar.gz", dest, {
      lookup: async () => [{ address: "10.89.10.3", family: 4 }],
    })

    expect(new Uint8Array(await readFile(dest))).toEqual(bytes)
  })

  it("enforces the byte cap", async () => {
    const big = new Uint8Array(2048)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(big)),
    )
    await expect(
      downloadToFile("https://spaces.example.com/big.bundle", await tmpFile(), {
        lookup: publicLookup,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds/)
  })

  it("re-validates redirects and refuses a hop to an internal host", async () => {
    // First hop is public + 302s to the cloud-metadata address; the per-hop guard
    // must refuse the second hop (not just the first).
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      downloadToFile("https://spaces.example.com/run.bundle", await tmpFile(), {
        lookup: publicLookup,
      }),
    ).rejects.toThrow(/internal/)
  })

  it("rejects a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    )
    await expect(
      downloadToFile("https://spaces.example.com/missing.bundle", await tmpFile(), {
        lookup: publicLookup,
      }),
    ).rejects.toThrow(/HTTP 403/)
  })
})
