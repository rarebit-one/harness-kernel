import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  denyCrossWorkspace,
  resolveWithin,
  writeFileCapability,
  type CapabilityContext,
} from "./capability.js"

// The kernel's capability surface is now exactly one tool — the one that
// carries no product semantics. The security properties it must hold (workspace
// scoping, sandbox containment) are the same ones an application inherits when
// it builds its own capabilities on the exported guards, so they are asserted
// here rather than in whatever composes them.

function makeCtx(workdir: string, workspaceId = "ws-self"): CapabilityContext {
  return { workspaceId, workdir }
}

describe("capability surface (security contract)", () => {
  let workdir: string
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "cap-test-"))
  })

  it("advertises no workspace_id — scope is not agent-selectable", () => {
    expect(Object.keys(writeFileCapability(makeCtx(workdir)).schema)).not.toContain("workspace_id")
  })

  describe("cross-workspace denial", () => {
    it("write_file targeting another workspace is denied and writes nothing", async () => {
      const res = await writeFileCapability(makeCtx(workdir)).handler({
        workspace_id: "ws-other",
        path: "a.md",
        content: "leak",
      })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/cross-workspace/i)
      await expect(readFile(path.join(workdir, "a.md"), "utf8")).rejects.toThrow()
    })

    it("a matching workspace_id is allowed (scope is enforced, not merely present-blocked)", async () => {
      const res = await writeFileCapability(makeCtx(workdir)).handler({
        workspace_id: "ws-self",
        path: "a.md",
        content: "ok",
      })
      expect(res.ok).toBe(true)
    })

    it("denyCrossWorkspace is exported so app capabilities inherit the same guard", () => {
      expect(denyCrossWorkspace({ workspace_id: "ws-other" }, "ws-self")?.ok).toBe(false)
      expect(denyCrossWorkspace({ workspaceId: "ws-other" }, "ws-self")?.ok).toBe(false)
      expect(denyCrossWorkspace({ workspace_id: "ws-self" }, "ws-self")).toBeNull()
      expect(denyCrossWorkspace({}, "ws-self")).toBeNull()
    })
  })

  describe("write_file", () => {
    it("writes within the sandbox, creating parent directories", async () => {
      const res = await writeFileCapability(makeCtx(workdir)).handler({
        path: "reports/out.md",
        content: "# hi",
      })
      expect(res.ok).toBe(true)
      expect(await readFile(path.join(workdir, "reports/out.md"), "utf8")).toBe("# hi")
    })

    it("refuses a path that escapes the sandbox and writes nothing outside", async () => {
      const res = await writeFileCapability(makeCtx(workdir)).handler({
        path: "../escape.md",
        content: "leak",
      })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/escapes sandbox/i)
      await expect(
        readFile(path.join(path.dirname(workdir), "escape.md"), "utf8"),
      ).rejects.toThrow()
    })

    it("refuses an absolute path", async () => {
      const outside = path.join(await mkdtemp(path.join(tmpdir(), "cap-out-")), "abs.md")
      const res = await writeFileCapability(makeCtx(workdir)).handler({
        path: outside,
        content: "leak",
      })
      expect(res.ok).toBe(false)
      await expect(readFile(outside, "utf8")).rejects.toThrow()
      await rm(path.dirname(outside), { recursive: true, force: true })
    })

    it("rejects a missing path or non-string content", async () => {
      const cap = writeFileCapability(makeCtx(workdir))
      expect((await cap.handler({ content: "x" })).ok).toBe(false)
      expect((await cap.handler({ path: "a.md" })).ok).toBe(false)
    })

    it("does not disturb a pre-existing file outside the escape attempt", async () => {
      // Belt-and-suspenders: a sibling file next to the sandbox stays untouched.
      const sibling = path.join(path.dirname(workdir), "cap-sibling.txt")
      await mkdir(path.dirname(sibling), { recursive: true })
      await writeFile(sibling, "original")
      await writeFileCapability(makeCtx(workdir)).handler({
        path: "../cap-sibling.txt",
        content: "hacked",
      })
      expect(await readFile(sibling, "utf8")).toBe("original")
      await rm(sibling, { force: true })
    })

    it("resolveWithin is exported and refuses escapes", () => {
      expect(resolveWithin(workdir, "a/b.md")).toBe(path.join(workdir, "a/b.md"))
      expect(() => resolveWithin(workdir, "../out.md")).toThrow(/escapes sandbox/i)
    })
  })
})
