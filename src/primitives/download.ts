import { createWriteStream } from "node:fs"
import { copyFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { assertSafeUrl, type Lookup } from "./http.js"

const FALLBACK_MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB
const FALLBACK_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 5

export interface DownloadOptions {
  maxBytes?: number
  timeoutMs?: number
  /** DNS resolver, injectable to test the SSRF guard without real DNS. */
  lookup?: Lookup
}

function defaultMaxBytes(): number {
  const raw = Number(process.env.RUNNER_BUNDLE_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_MAX_BYTES
}

function defaultTimeoutMs(): number {
  const raw = Number(process.env.RUNNER_BUNDLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_TIMEOUT_MS
}

/**
 * Download a (binary) URL to a file on disk, bounded by a byte cap and a timeout,
 * with the same SSRF guard as httpFetch (internal hosts refused, every redirect
 * hop re-validated). Unlike httpFetch this streams to disk — snapshot tarballs are
 * binary and can be far larger than httpFetch's in-memory string cap. Used to fetch
 * a run's snapshot `.tar.gz` from a presigned object-store URL (or, in local dev, a
 * co-located `file://` URL).
 *
 * On any failure the partial file is removed and the error re-thrown.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  // Local/dev handoff: the LocalAdapter object store hands a `file://` URL (the
  // control plane and runner are co-located on one machine). Copy it straight from
  // disk — never through fetch/the SSRF guard. This reads an arbitrary local path, so
  // it is OPT-IN via RUNNER_ALLOW_FILE_URLS (dev/test only); production uses https
  // presigned URLs and leaves it off, so a misconfigured `file://` URL is refused.
  if (url.startsWith("file://")) {
    if (process.env.RUNNER_ALLOW_FILE_URLS !== "1") {
      throw new Error("file:// URLs are disabled; set RUNNER_ALLOW_FILE_URLS=1 for local dev")
    }
    await copyFile(fileURLToPath(url), destPath)
    return
  }

  const maxBytes = opts.maxBytes ?? defaultMaxBytes()
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs()

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    // Follow redirects manually so each hop is re-validated against the SSRF guard.
    // Private/VPC object stores (and the MinIO-backed load-test rig) hand out
    // presigned URLs on hosts that resolve to private addresses, which the guard
    // refuses. OPT-IN escape hatch in the spirit of RUNNER_ALLOW_FILE_URLS: skip
    // the guard for the snapshot download only (byte cap, timeout, and redirect
    // bounds still apply). Leave unset in production with a public object store.
    // NOTE: when set, the skip DELIBERATELY applies to every hop, redirect
    // targets included — once private hosts are trusted there is no meaningful
    // boundary left for per-hop re-validation to defend. Don't "fix" that by
    // reinstating per-hop checks under the flag; it would break private stores
    // that redirect internally.
    const allowPrivate = process.env.RUNNER_ALLOW_PRIVATE_BUNDLE_HOSTS === "1"
    let current = url
    let res: Response
    for (let hops = 0; ; hops++) {
      if (!allowPrivate) await assertSafeUrl(current, { lookup: opts.lookup })
      res = await fetch(current, { redirect: "manual", signal: controller.signal })
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        if (hops >= MAX_REDIRECTS) throw new Error("too many redirects")
        current = new URL(res.headers.get("location") as string, current).toString()
        continue
      }
      break
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`download failed: HTTP ${res.status} for ${url}`)
    }
    if (!res.body) throw new Error(`download failed: empty body for ${url}`)

    const out = createWriteStream(destPath)
    // undici's ReadableStream types are non-generic, so the reader yields `any`;
    // fetch response bodies are always byte streams.
    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error(`download exceeds ${maxBytes} bytes`)
        }
        await new Promise<void>((resolve, reject) => {
          out.write(value, (err) => (err ? reject(err) : resolve()))
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      )
    }
  } catch (err) {
    await rm(destPath, { force: true })
    if (timedOut) throw new Error(`download timeout after ${timeoutMs}ms: ${url}`, { cause: err })
    throw err
  } finally {
    clearTimeout(timer)
  }
}
