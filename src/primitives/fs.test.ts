import { describe, it, expect, beforeAll } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readFileSafe, listFiles } from "./fs.js"

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
