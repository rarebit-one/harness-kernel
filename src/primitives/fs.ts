import { open, readdir, realpath } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"

const DEFAULT_MAX_BYTES = 64 * 1024

/** Lexical guard: refuse a relative path that escapes the sandbox via `..`. */
function resolveWithin(dir: string, relPath: string): string {
  const base = path.resolve(dir)
  const target = path.resolve(base, relPath)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes sandbox: ${relPath}`)
  }
  return target
}

/** True if `target`'s real (symlink-resolved) path stays within the real base. */
async function realWithin(base: string, target: string): Promise<boolean> {
  const realBase = await realpath(base)
  const real = await realpath(target)
  return real === realBase || real.startsWith(realBase + path.sep)
}

/**
 * Read a UTF-8 file within the sandbox, or null if missing / not a file / too
 * big / a symlink escape.
 *
 * **The file is opened ONCE and every subsequent check runs against that file
 * descriptor**, not against the path again. The path is resolved a single time;
 * type, size and contents all come from the fd.
 *
 * That matters because this is a sandbox guard and the sandbox's threat model is
 * untrusted code running *inside* it (`run_code` executes arbitrary code in this
 * same tree). The previous shape resolved the path three times — `realpath`,
 * then `stat`, then `readFile` — so an attacker who swapped `target` for a
 * symlink after the check but before the read got a file the guard never
 * approved. A descriptor pins the inode: once open, nothing about the path can
 * change what these bytes are.
 *
 * `O_NOFOLLOW` closes the remaining window at the final component — the resolved
 * path must not itself have become a symlink between `realpath` and `open`.
 *
 * **Stated limit:** a swap of an intermediate *directory* component in that same
 * window is still theoretically possible. Closing that needs `openat`/`O_PATH`
 * walking, which Node does not expose. This narrows the window from "any of
 * three resolutions" to "one, with the final component pinned" — it does not
 * mathematically eliminate it, and saying otherwise would be worse than the bug.
 */
export async function readFileSafe(
  dir: string,
  relPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string | null> {
  const target = resolveWithin(dir, relPath)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Resolve symlinks and re-check: a link inside the sandbox must not point out.
    if (!(await realWithin(dir, target))) return null
    // O_NOFOLLOW: refuse if the final component is a symlink now, whatever it
    // was a moment ago.
    fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await fh.stat()
    if (!info.isFile() || info.size > maxBytes) return null
    return await fh.readFile("utf8")
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** List files (recursively, `.git` excluded) under `relDir`, as sandbox-relative paths. */
export async function listFiles(dir: string, relDir = "."): Promise<string[]> {
  const base = path.resolve(dir)
  const root = resolveWithin(dir, relDir)
  const out: string[] = []

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue // don't follow symlinks out of the sandbox
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue
        await walk(abs)
      } else if (entry.isFile()) {
        out.push(path.relative(base, abs))
      }
    }
  }

  await walk(root)
  return out.sort()
}
