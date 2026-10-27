import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  environmentInstructions,
  frontmatterField,
  hasEnvironment,
  materializeEnvironment,
  skillsIndex,
  writeSkills,
  type RunSkill,
} from "./environment.js"

/** Every file under `dir` → sha256, the shape a caller's change-set diff sees. */
async function tree(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, await tree(abs, base))
    else
      out[path.relative(base, abs)] = createHash("sha256")
        .update(await readFile(abs))
        .digest("hex")
  }
  return out
}

/** Every directory under `dir`, so a leftover empty one is visible too. */
async function dirs(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const abs = path.join(dir, entry.name)
    out.push(path.relative(base, abs), ...(await dirs(abs, base)))
  }
  return out.sort()
}

const SKILL: RunSkill = {
  name: "csv-report",
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: csv-report\ndescription: Turn a CSV into a Markdown report.\n---\n\nBody.",
    },
    { path: "scripts/report.py", content: "print('report')\n" },
  ],
}

describe("materializeEnvironment", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "env-wd-"))
    await mkdir(path.join(workdir, "campaigns"))
    await writeFile(path.join(workdir, "campaigns/q3.md"), "# Q3\n")
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it("writes every workdir-bound field, then restores the tree byte-for-byte", async () => {
    const before = await tree(workdir)
    const beforeDirs = await dirs(workdir)
    const env = await materializeEnvironment({
      workdir,
      instructions: { system: "not a file", agentsMd: "# Env conventions" },
      agentFiles: [{ path: "campaigns/AGENTS.md", content: "Never rename briefs." }],
      skills: [SKILL],
      sources: [{ kind: "inline", path: "data/rates.csv", content: "USD,1.35\n" }],
    })

    expect(env.paths).toEqual([
      "AGENTS.md",
      "campaigns/AGENTS.md",
      ".agents/skills/csv-report/SKILL.md",
      ".agents/skills/csv-report/scripts/report.py",
      "data/rates.csv",
    ])
    expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toBe("# Env conventions")
    expect(await readFile(path.join(workdir, "data/rates.csv"), "utf8")).toBe("USD,1.35\n")
    expect(
      await readFile(path.join(workdir, ".agents/skills/csv-report/scripts/report.py"), "utf8"),
    ).toBe("print('report')\n")

    expect(await env.restore()).toEqual({ kept: [] })
    expect(await tree(workdir)).toEqual(before)
    // No empty directories left behind either.
    expect(await dirs(workdir)).toEqual(beforeDirs)
  })

  it("puts environment instructions ahead of the workspace's own AGENTS.md and restores it", async () => {
    await writeFile(path.join(workdir, "AGENTS.md"), "# Workspace rules\n")
    const env = await materializeEnvironment({ workdir, instructions: { agentsMd: "# Env" } })
    expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toBe(
      "# Env\n\n# Workspace rules\n",
    )
    await env.restore()
    expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toBe("# Workspace rules\n")
  })

  it("keeps a harness's edit below the merged block, and removes only the block", async () => {
    await writeFile(path.join(workdir, "AGENTS.md"), "# Workspace rules\n")
    const env = await materializeEnvironment({ workdir, instructions: { agentsMd: "# Env" } })
    const merged = await readFile(path.join(workdir, "AGENTS.md"), "utf8")
    await writeFile(path.join(workdir, "AGENTS.md"), `${merged}- a rule the run added\n`)
    expect(await env.restore()).toEqual({ kept: [] })
    expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toBe(
      "# Workspace rules\n- a rule the run added\n",
    )
  })

  it("leaves a created file the harness rewrote, and reports it", async () => {
    const env = await materializeEnvironment({
      workdir,
      sources: [{ kind: "inline", path: "data/rates.csv", content: "USD,1.35\n" }],
    })
    await writeFile(path.join(workdir, "data/rates.csv"), "USD,1.40\n")
    expect(await env.restore()).toEqual({ kept: ["data/rates.csv"] })
    expect(await readFile(path.join(workdir, "data/rates.csv"), "utf8")).toBe("USD,1.40\n")
  })

  it("decodes base64 content", async () => {
    const env = await materializeEnvironment({
      workdir,
      sources: [
        {
          kind: "inline",
          path: "bin.dat",
          content: Buffer.from([0, 1, 2]).toString("base64"),
          encoding: "base64",
        },
      ],
    })
    expect([...(await readFile(path.join(workdir, "bin.dat")))]).toEqual([0, 1, 2])
    await env.restore()
  })

  it.each([
    [
      "a source overwriting a workspace file",
      { sources: [{ kind: "inline" as const, path: "campaigns/q3.md", content: "x" }] },
      /would overwrite a workspace file: campaigns\/q3.md/,
    ],
    [
      "an absolute path",
      { sources: [{ kind: "inline" as const, path: "/etc/passwd", content: "x" }] },
      /must be relative/,
    ],
    [
      "a path escaping the workdir",
      { sources: [{ kind: "inline" as const, path: "a/../../x", content: "x" }] },
      /escapes the workdir/,
    ],
    [
      "an unknown source kind",
      { sources: [{ kind: "git", path: "repo", content: "" } as never] },
      /unsupported source kind "git"/,
    ],
    [
      "a skill name that is not a slug",
      { skills: [{ ...SKILL, name: "Bad Name" }] },
      /skill name must match/,
    ],
    [
      "a skill without SKILL.md",
      { skills: [{ name: "x", files: [{ path: "a.md", content: "" }] }] },
      /has no SKILL.md/,
    ],
    [
      "an agent file not named AGENTS.md",
      { agentFiles: [{ path: "campaigns/notes.md", content: "x" }] },
      /must be named AGENTS.md/,
    ],
    [
      "the same path twice",
      { instructions: { agentsMd: "a" }, agentFiles: [{ path: "./AGENTS.md", content: "b" }] },
      /writes AGENTS.md twice/,
    ],
    [
      "an unknown encoding",
      { sources: [{ kind: "inline" as const, path: "x", content: "x", encoding: "hex" as never }] },
      /unknown encoding/,
    ],
  ])("refuses %s and leaves the tree untouched", async (_label, fields, error) => {
    const before = await tree(workdir)
    await expect(
      materializeEnvironment({
        workdir,
        // A valid file first, so a refusal after it proves nothing was written.
        sources: [{ kind: "inline", path: "first.txt", content: "1" }],
        ...fields,
      }),
    ).rejects.toThrow(error)
    expect(await tree(workdir)).toEqual(before)
  })

  it("refuses to write through a symlink in the snapshot", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "env-outside-"))
    try {
      await symlink(outside, path.join(workdir, "link"))
      await expect(
        materializeEnvironment({
          workdir,
          agentFiles: [{ path: "link/AGENTS.md", content: "x" }],
        }),
      ).rejects.toThrow(/passes through a symlink: link\/AGENTS.md/)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("restores nothing through a symlink the harness swapped in, and reports it", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "env-outside-"))
    try {
      await writeFile(path.join(workdir, "campaigns/AGENTS.md"), "local\n")
      const env = await materializeEnvironment({
        workdir,
        agentFiles: [{ path: "campaigns/AGENTS.md", content: "ENV" }],
      })
      const merged = await readFile(path.join(workdir, "campaigns/AGENTS.md"))
      // The harness replaces the parent directory with a link to an outside
      // directory holding a file that starts with the same block.
      await rename(path.join(workdir, "campaigns"), path.join(workdir, "moved"))
      await symlink(outside, path.join(workdir, "campaigns"))
      await writeFile(path.join(outside, "AGENTS.md"), merged)

      expect(await env.restore()).toEqual({ kept: ["campaigns/AGENTS.md"] })
      expect(await readFile(path.join(outside, "AGENTS.md"))).toEqual(merged)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("undoes the files it had written when a later write fails", async () => {
    // Passes planning, fails at write time: the target is a directory.
    await mkdir(path.join(workdir, "data/rates.csv"), { recursive: true })
    const before = await tree(workdir)
    await expect(
      materializeEnvironment({
        workdir,
        instructions: { agentsMd: "# Env" },
        sources: [{ kind: "inline", path: "data/rates.csv", content: "x" }],
      }),
    ).rejects.toThrow(/not a regular file: data\/rates.csv/)
    expect(await tree(workdir)).toEqual(before)
  })

  it("is a no-op on a spec without environment fields", async () => {
    const before = await tree(workdir)
    const env = await materializeEnvironment({ workdir })
    expect(env.paths).toEqual([])
    expect(await env.restore()).toEqual({ kept: [] })
    expect(await tree(workdir)).toEqual(before)
  })
})

describe("writeSkills", () => {
  it("lays skills out as <dir>/<name>/…", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "env-skills-"))
    try {
      await writeSkills(dir, [SKILL])
      expect(Object.keys(await tree(dir)).sort()).toEqual([
        "csv-report/SKILL.md",
        "csv-report/scripts/report.py",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("environment helpers", () => {
  it("hasEnvironment is false for absent and empty fields", () => {
    expect(hasEnvironment({})).toBe(false)
    expect(hasEnvironment({ instructions: {}, agentFiles: [], skills: [], sources: [] })).toBe(
      false,
    )
    expect(hasEnvironment({ instructions: { system: "x" } })).toBe(true)
    expect(hasEnvironment({ skills: [SKILL] })).toBe(true)
  })

  it("reads single-line frontmatter scalars and ignores block scalars", () => {
    const md = '---\nname: x\ndescription: "Quoted: yes"\nother: >\n  folded\n---\nbody'
    expect(frontmatterField(md, "description")).toBe("Quoted: yes")
    expect(frontmatterField(md, "other")).toBeUndefined()
    expect(frontmatterField("no frontmatter", "name")).toBeUndefined()
  })

  it("indexes skills with their materialized path and description", () => {
    expect(
      skillsIndex([SKILL, { name: "bare", files: [{ path: "SKILL.md", content: "Just do it." }] }]),
    ).toBe(
      [
        "## Skills",
        "Each skill is a directory in the workspace. Before doing a task a skill covers, read",
        "its SKILL.md and follow it.",
        "- csv-report (.agents/skills/csv-report/SKILL.md): Turn a CSV into a Markdown report.",
        "- bare (.agents/skills/bare/SKILL.md)",
      ].join("\n"),
    )
    expect(skillsIndex(undefined)).toBeUndefined()
    expect(skillsIndex([])).toBeUndefined()
  })

  it("composes only the parts a harness asked for, and nothing for an empty environment", () => {
    const spec = { instructions: { system: "SYS", agentsMd: "AGENTS" }, skills: [SKILL] }
    expect(environmentInstructions(spec, { agentsMd: false, skillsIndex: false })).toBe("SYS")
    expect(environmentInstructions(spec, { agentsMd: true, skillsIndex: false })).toBe(
      "SYS\n\nAGENTS",
    )
    expect(environmentInstructions({}, { agentsMd: true, skillsIndex: true })).toBeUndefined()
  })

  it("inlines nested agent files, scoped to their directory, for a harness without discovery", () => {
    const spec = { agentFiles: [{ path: "campaigns/AGENTS.md", content: "Cite sources.\n" }] }
    expect(environmentInstructions(spec, { agentsMd: true, skillsIndex: false })).toBe(
      [
        "## Instructions for `campaigns/`",
        "These apply when working in `campaigns/` and below.",
        "",
        "Cite sources.",
      ].join("\n"),
    )
    expect(environmentInstructions(spec, { agentsMd: false, skillsIndex: false })).toBeUndefined()
    expect(
      environmentInstructions(
        { instructions: { system: "  " } },
        { agentsMd: true, skillsIndex: true },
      ),
    ).toBeUndefined()
  })
})
