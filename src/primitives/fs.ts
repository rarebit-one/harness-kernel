import { readFile, readdir, stat, realpath } from "node:fs/promises"
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

/** Read a UTF-8 file within the sandbox, or null if missing / not a file / too big / a symlink escape. */
export async function readFileSafe(
  dir: string,
  relPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string | null> {
  const target = resolveWithin(dir, relPath)
  try {
    // Resolve symlinks and re-check: a link inside the sandbox must not point out.
    if (!(await realWithin(dir, target))) return null
    const info = await stat(target)
    if (!info.isFile() || info.size > maxBytes) return null
    return await readFile(target, "utf8")
  } catch {
    return null
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
