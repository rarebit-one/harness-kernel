import { describe, it, expect, beforeAll } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readFileSafe, readSandboxFile, listFiles } from "./fs.js"

describe("fs primitives", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ws-fs-"))
    await mkdir(path.join(dir, "sub"), { recursive: true })
    await writeFile(path.join(dir, "a.txt"), "alpha")
    await writeFile(path.join(dir, "sub", "b.txt"), "beta")
  })

  it("reads a file within the sandbox", async () => {
    expect(await readFileSafe(dir, "a.txt")).toBe("alpha")
  })

  it("returns null for a missing file", async () => {
    expect(await readFileSafe(dir, "missing.txt")).toBeNull()
  })

  it("rejects path traversal outside the sandbox", async () => {
    await expect(readFileSafe(dir, "../escape")).rejects.toThrow(/escapes sandbox/)
  })

  it("lists files recursively, sandbox-relative", async () => {
    expect(await listFiles(dir)).toEqual(["a.txt", path.join("sub", "b.txt")])
  })

  it("does not follow a symlink that escapes the sandbox", async () => {
    const box = await mkdtemp(path.join(tmpdir(), "ws-box-"))
    const outside = await mkdtemp(path.join(tmpdir(), "ws-out-"))
    await writeFile(path.join(outside, "secret.txt"), "leak")
    await symlink(path.join(outside, "secret.txt"), path.join(box, "link.txt"))

    expect(await readFileSafe(box, "link.txt")).toBeNull()
    expect(await listFiles(box)).not.toContain("link.txt")
  })
})

describe("readFileSafe TOCTOU hardening", () => {
  it("refuses a symlinked final component even when it points INSIDE the sandbox", async () => {
    // O_NOFOLLOW. The link is legal by every path rule — it resolves inside the
    // sandbox — and is still refused, because the guard's job is to read the file
    // it checked, not an equivalent one. That is what makes the descriptor the
    // unit of trust rather than the path.
    const dir = await mkdtemp(path.join(tmpdir(), "fs-toctou-"))
    await writeFile(path.join(dir, "real.txt"), "payload")
    await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"))

    expect(await readFileSafe(dir, "real.txt")).toBe("payload")
    expect(await readFileSafe(dir, "link.txt")).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })

  it("applies the byte cap to the OPENED file, not to a separate stat", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fs-cap-"))
    await writeFile(path.join(dir, "big.txt"), "x".repeat(200))
    expect(await readFileSafe(dir, "big.txt", 100)).toBeNull()
    expect(await readFileSafe(dir, "big.txt", 1000)).toHaveLength(200)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("readSandboxFile", () => {
  it("names why it returned no text", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fs-read-"))
    await writeFile(path.join(dir, "a.txt"), "alpha")
    await writeFile(path.join(dir, "big.txt"), "x".repeat(200))
    await writeFile(path.join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))
    await writeFile(path.join(dir, "latin1.csv"), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    await mkdir(path.join(dir, "sub"))

    expect(await readSandboxFile(dir, "a.txt")).toEqual({ kind: "text", text: "alpha" })
    expect(await readSandboxFile(dir, "missing.txt")).toEqual({ kind: "missing" })
    expect(await readSandboxFile(dir, "big.txt", 100)).toEqual({
      kind: "too_large",
      bytes: 200,
      maxBytes: 100,
    })
    expect(await readSandboxFile(dir, "img.png")).toEqual({ kind: "binary", bytes: 6 })
    expect(await readSandboxFile(dir, "latin1.csv")).toEqual({ kind: "binary", bytes: 4 })
    expect(await readSandboxFile(dir, "sub")).toEqual({ kind: "directory" })
    await rm(dir, { recursive: true, force: true })
  })

  it("reports a symlink escape as missing, revealing nothing about the target", async () => {
    const box = await mkdtemp(path.join(tmpdir(), "fs-read-box-"))
    const outside = await mkdtemp(path.join(tmpdir(), "fs-read-out-"))
    await writeFile(path.join(outside, "secret.txt"), "x".repeat(500))
    await symlink(path.join(outside, "secret.txt"), path.join(box, "link.txt"))

    expect(await readSandboxFile(box, "link.txt", 100)).toEqual({ kind: "missing" })
  })
})
