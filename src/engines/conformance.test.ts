/**
 * Engine conformance for a run's environment: ONE spec carrying every
 * environment field, compiled by every engine, each pinned to a readable
 * golden under `__goldens__/conformance/`. A change to how any engine hands
 * instructions, AGENTS.md or skills to its harness shows up as a golden diff.
 *
 * The second half proves the other direction: a spec without the fields
 * compiles exactly as it did before they existed.
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Loop, LoopRequest } from "../loop.js"
import { AcpEngine, EVE_AGENT, type AcpDriver, type AcpOptions } from "./acp.js"
import { ClaudeCodeEngine, type ClaudeCodeMessage, type ClaudeCodeOptions } from "./claudeCode.js"
import { environmentSdkOptions } from "./claudeCodeDriver.js"
import { CodexEngine, type CodexMessage, type CodexOptions } from "./codex.js"
import { materializeEnvironment } from "./environment.js"
import { NativeEngine } from "./native.js"
import type { RunSpec } from "./types.js"

const GOLDENS = "./__goldens__/conformance"
const SCRIPT = "/opt/harness/capabilityStdio.js"

/** The environment every engine compiles. Every field, nothing else unusual. */
const ENVIRONMENT: Pick<RunSpec, "instructions" | "agentFiles" | "skills" | "sources"> = {
  instructions: {
    system: "You are the finance team's analyst. Never email anyone.",
    agentsMd: "# Conventions\n\nCurrency is SGD unless stated.",
  },
  agentFiles: [{ path: "campaigns/AGENTS.md", content: "Campaign briefs live here." }],
  skills: [
    {
      name: "csv-report",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: csv-report\ndescription: Turn a CSV into a Markdown report.\n---\n\nRun scripts/report.py.",
        },
        { path: "scripts/report.py", content: "print('report')\n" },
      ],
    },
  ],
  sources: [{ kind: "inline", path: "data/rates.csv", content: "currency,rate\nUSD,1.35\n" }],
}

function spec(workdir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "ws-self",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing.", runner: { profile: "ephemeral" } },
    inputs: { quarter: "Q3" },
    context: "",
    workdir,
    permissions: {},
    secrets: {},
    connectors: [],
    provider: { preferred: "mock" },
    ...overrides,
  }
}

const ctx = { log: () => {} }

/** Replace per-run temp paths and the node binary so a golden is stable across machines and runs. */
function stable(text: string, workdir: string): string {
  return text
    .split(workdir)
    .join("<workdir>")
    .split(process.execPath)
    .join("<node>")
    .replace(/[^\s"']*harness-[a-z-]+-[A-Za-z0-9]+/g, "<tmp>")
}

async function listing(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listing(abs, base)))
    else out.push(`${path.relative(base, abs)}  ${(await readFile(abs)).length}B`)
  }
  return out.sort()
}

async function digest(dir: string): Promise<string> {
  const lines = await listing(dir)
  const hash = createHash("sha256")
  for (const line of lines) {
    const rel = line.split("  ")[0]!
    hash.update(rel).update(await readFile(path.join(dir, rel)))
  }
  return hash.digest("hex")
}

// Each runner returns what the engine handed its harness, as text.
type Compile = (s: RunSpec) => Promise<string>

const compileNative: Compile = async (s) => {
  let seen: LoopRequest | undefined
  const loop: Loop = {
    name: "capture",
    run: async (req) => {
      seen = req
      return { text: "", steps: 0, outcome: "completed" }
    },
  }
  await new NativeEngine({ loop }).run(s, ctx)
  return [
    "=== system",
    seen?.system ?? "",
    "=== user",
    seen?.messages[0] && "text" in seen.messages[0] ? String(seen.messages[0].text) : "",
  ].join("\n")
}

const compileClaudeCode: Compile = async (s) => {
  let seen: ClaudeCodeOptions | undefined
  let plugin: string[] = []
  async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
    seen = opts
    plugin = opts.pluginDirs?.[0] ? await listing(opts.pluginDirs[0]) : []
    yield { kind: "result", text: "ok", isError: false }
  }
  await new ClaudeCodeEngine(driver).run(s, ctx)
  const { mcpTools, ...options } = seen!
  return [
    "=== options",
    JSON.stringify({ ...options, mcpTools: mcpTools?.map((t) => t.name) }, null, 2),
    "=== sdk options from the environment",
    JSON.stringify(environmentSdkOptions(seen!), null, 2),
    "=== plugin",
    ...plugin,
  ].join("\n")
}

const compileCodex: Compile = async (s) => {
  let seen: CodexOptions | undefined
  let home: string[] = []
  let agents = ""
  let config = ""
  async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
    seen = opts
    // Names only: config.toml holds machine paths, so its size varies; its content is below.
    home = (await listing(opts.codexHome)).map((line) => line.replace(/ {2}\d+B$/, ""))
    agents = await readFile(path.join(opts.codexHome, "AGENTS.md"), "utf8").catch(() => "(none)")
    config = await readFile(path.join(opts.codexHome, "config.toml"), "utf8").catch(() => "(none)")
    yield { kind: "result", text: "ok", isError: false }
  }
  await new CodexEngine(driver, SCRIPT).run(s, ctx)
  return [
    "=== prompt",
    seen!.prompt,
    "=== CODEX_HOME",
    ...home,
    "=== CODEX_HOME/AGENTS.md",
    agents,
    "=== CODEX_HOME/config.toml",
    config,
  ].join("\n")
}

const compileAcp: Compile = async (s) => {
  let seen: AcpOptions | undefined
  const drive = (async (opts: AcpOptions) => {
    seen = opts
    return { stopReason: "end_turn" }
  }) as AcpDriver
  await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(s, ctx)
  return ["=== prompt", seen!.prompt].join("\n")
}

const ENGINES: Array<[string, Compile]> = [
  ["native", compileNative],
  ["claude-code", compileClaudeCode],
  ["codex", compileCodex],
  ["acp", compileAcp],
]

describe("environment conformance", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "conformance-wd-"))
    await writeFile(path.join(workdir, "AGENTS.md"), "# Workspace rules\n")
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it("materializes one golden workdir layout, and restores it", async () => {
    const before = await digest(workdir)
    const env = await materializeEnvironment(spec(workdir, ENVIRONMENT))
    const layout = await listing(workdir)
    const agents = await readFile(path.join(workdir, "AGENTS.md"), "utf8")
    await env.restore()
    expect(await digest(workdir)).toBe(before)
    await expect(
      ["=== workdir", ...layout, "=== AGENTS.md", agents].join("\n") + "\n",
    ).toMatchFileSnapshot(`${GOLDENS}/workdir.txt`)
  })

  it.each(ENGINES)("%s compiles the environment to its golden", async (name, compile) => {
    const env = await materializeEnvironment(spec(workdir, ENVIRONMENT))
    try {
      const out = stable(await compile(spec(workdir, ENVIRONMENT)), workdir)
      await expect(`${out}\n`).toMatchFileSnapshot(`${GOLDENS}/${name}.txt`)
    } finally {
      await env.restore()
    }
  })

  it.each(ENGINES)(
    "%s compiles a spec without environment fields exactly as one with them empty",
    async (_name, compile) => {
      const bare = await compile(spec(workdir))
      const empty = await compile(
        spec(workdir, { instructions: {}, agentFiles: [], skills: [], sources: [] }),
      )
      expect(stable(empty, workdir)).toBe(stable(bare, workdir))
    },
  )

  it("leaves the native system prompt exactly as it was before the slot existed", async () => {
    const out = await compileNative(spec(workdir))
    expect(out.split("=== user")[0]).toBe(
      [
        "=== system",
        "You are an autonomous workflow executing in an isolated workspace sandbox.",
        "Workspace: ws-self",
        "Workflow: Demo",
        "Use the provided tools to inspect the workspace, run the repo's own code, and",
        "call connectors as needed. Delegate anything that must be precise or",
        "reproducible (calculations, dates, side effects) to code via run_code rather",
        "than doing it yourself. When finished, reply with the workflow's output as",
        "Markdown and no further tool calls.",
        "",
      ].join("\n"),
    )
  })

  it("adds no Claude Code option and no SDK option without an environment", async () => {
    let seen: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      seen = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    await new ClaudeCodeEngine(driver).run(spec(workdir), ctx)
    expect(Object.keys(seen!).sort()).toEqual(["cwd", "mcpTools", "model", "prompt"])
    expect(environmentSdkOptions(seen!)).toEqual({})
  })

  it("leaves CODEX_HOME holding only config.toml without an environment", async () => {
    const out = await compileCodex(spec(workdir))
    expect(out).toContain("=== CODEX_HOME\nconfig.toml")
    expect(out).toContain("=== CODEX_HOME/AGENTS.md\n(none)")
  })

  it("removes the Claude Code skills plugin after the run", async () => {
    let pluginDir = ""
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      pluginDir = opts.pluginDirs![0]!
      yield { kind: "result", text: "ok", isError: false }
    }
    await new ClaudeCodeEngine(driver).run(spec(workdir, ENVIRONMENT), ctx)
    expect(pluginDir.startsWith(workdir)).toBe(false)
    await expect(readdir(pluginDir)).rejects.toThrow(/ENOENT/)
  })
})
