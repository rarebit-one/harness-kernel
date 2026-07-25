import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CAPABILITY_TOOL_NAMES,
  capabilityTools,
  type CapabilityContext,
  type CapabilityTool,
} from "./capability.js"

function makeCtx(workdir: string, workspaceId = "ws-self"): CapabilityContext {
  return { workspaceId, workdir, issues: [], knowledge: [] }
}

function tool(tools: CapabilityTool[], name: string): CapabilityTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no such capability: ${name}`)
  return t
}

describe("capability surface (security contract)", () => {
  let workdir: string
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "cap-test-"))
  })

  it("exposes EXACTLY open_issue, write_file, promote_knowledge — no privileged ops", () => {
    const names = capabilityTools(makeCtx(workdir))
      .map((t) => t.name)
      .sort()
    expect(names).toEqual([...CAPABILITY_TOOL_NAMES].sort())

    // A host application's privileged operations must never leak into the
    // kernel-hosted surface: no workspace/org lifecycle, membership, or run control.
    const forbidden = [
      "run_workflow",
      "create_workspace",
      "create_organization",
      "add_workspace_member",
      "add_org_member",
      "invite_user",
      "approve_run",
      "reject_run",
      "list_workspaces",
    ]
    for (const f of forbidden) expect(names).not.toContain(f)
  })

  it("no capability's advertised schema accepts a workspace_id (scope is not agent-selectable)", () => {
    for (const t of capabilityTools(makeCtx(workdir))) {
      expect(Object.keys(t.schema)).not.toContain("workspace_id")
      expect(Object.keys(t.schema)).not.toContain("workspaceId")
    }
  })

  describe("cross-workspace denial", () => {
    it("open_issue targeting another workspace is denied and records nothing", async () => {
      const ctx = makeCtx(workdir, "ws-self")
      const res = await tool(capabilityTools(ctx), "open_issue").handler({
        title: "leak",
        workspace_id: "ws-other",
      })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/cross-workspace/i)
      expect(ctx.issues).toEqual([])
    })

    it("promote_knowledge targeting another workspace is denied and records nothing", async () => {
      const ctx = makeCtx(workdir, "ws-self")
      const res = await tool(capabilityTools(ctx), "promote_knowledge").handler({
        content: "leak",
        workspaceId: "ws-other",
      })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/cross-workspace/i)
      expect(ctx.knowledge).toEqual([])
    })

    it("write_file targeting another workspace is denied and writes nothing", async () => {
      const ctx = makeCtx(workdir, "ws-self")
      const res = await tool(capabilityTools(ctx), "write_file").handler({
        path: "note.md",
        content: "leak",
        workspace_id: "ws-other",
      })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/cross-workspace/i)
      await expect(readFile(path.join(workdir, "note.md"), "utf8")).rejects.toThrow()
    })

    it("a matching workspace_id is allowed (scope is enforced, not merely present-blocked)", async () => {
      const ctx = makeCtx(workdir, "ws-self")
      const res = await tool(capabilityTools(ctx), "open_issue").handler({
        title: "ok",
        workspace_id: "ws-self",
      })
      expect(res.ok).toBe(true)
      expect(ctx.issues).toEqual([{ title: "ok" }])
    })
  })

  describe("open_issue", () => {
    it("records a dedup-keyed, labelled issue into the run's sink", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "open_issue").handler({
        title: "Renewal scan",
        body: "2 due",
        dedupe_key: "renewal-scan",
        labels: ["ops", "renewals"],
      })
      expect(res.ok).toBe(true)
      expect(ctx.issues).toEqual([
        {
          title: "Renewal scan",
          body: "2 due",
          dedupe_key: "renewal-scan",
          labels: ["ops", "renewals"],
        },
      ])
    })

    it("rejects a missing title without recording", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "open_issue").handler({ body: "x" })
      expect(res.ok).toBe(false)
      expect(ctx.issues).toEqual([])
    })
  })

  describe("promote_knowledge", () => {
    it("records knowledge with optional title/kind", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "promote_knowledge").handler({
        content: "prefer X",
        title: "Pref",
        kind: "decision",
      })
      expect(res.ok).toBe(true)
      expect(ctx.knowledge).toEqual([{ content: "prefer X", title: "Pref", kind: "decision" }])
    })

    it("rejects missing content without recording", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "promote_knowledge").handler({ title: "x" })
      expect(res.ok).toBe(false)
      expect(ctx.knowledge).toEqual([])
    })
  })

  describe("write_file", () => {
    it("writes within the sandbox, creating parent directories", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "write_file").handler({
        path: "reports/out.md",
        content: "# hi",
      })
      expect(res.ok).toBe(true)
      expect(await readFile(path.join(workdir, "reports/out.md"), "utf8")).toBe("# hi")
    })

    it("refuses a path that escapes the sandbox and writes nothing outside", async () => {
      const ctx = makeCtx(workdir)
      const res = await tool(capabilityTools(ctx), "write_file").handler({
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
      const ctx = makeCtx(workdir)
      const outside = path.join(await mkdtemp(path.join(tmpdir(), "cap-out-")), "abs.md")
      const res = await tool(capabilityTools(ctx), "write_file").handler({
        path: outside,
        content: "leak",
      })
      expect(res.ok).toBe(false)
      await expect(readFile(outside, "utf8")).rejects.toThrow()
      await rm(path.dirname(outside), { recursive: true, force: true })
    })

    it("rejects a missing path or non-string content", async () => {
      const ctx = makeCtx(workdir)
      expect((await tool(capabilityTools(ctx), "write_file").handler({ content: "x" })).ok).toBe(
        false,
      )
      expect((await tool(capabilityTools(ctx), "write_file").handler({ path: "a.md" })).ok).toBe(
        false,
      )
    })

    it("does not disturb a pre-existing file outside the escape attempt", async () => {
      // Belt-and-suspenders: a sibling file next to the sandbox stays untouched.
      const sibling = path.join(path.dirname(workdir), "cap-sibling.txt")
      await mkdir(path.dirname(sibling), { recursive: true })
      await writeFile(sibling, "original")
      const ctx = makeCtx(workdir)
      await tool(capabilityTools(ctx), "write_file").handler({
        path: "../cap-sibling.txt",
        content: "hacked",
      })
      expect(await readFile(sibling, "utf8")).toBe("original")
      await rm(sibling, { force: true })
    })
  })
})
