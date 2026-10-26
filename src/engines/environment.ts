import { lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveWithin } from "./capability.js"
import type { RunSpec } from "./types.js"

/**
 * A run's environment: the instructions, instruction files, skills and input
 * files a caller wants every harness to start from, whatever engine runs it.
 *
 * Two halves, with a strict split between them:
 *
 *   - **Workdir files** — `AGENTS.md`, nested instruction files, skill
 *     directories and inline sources. These are the caller's to put on disk,
 *     with {@link materializeEnvironment}, because the caller owns the working
 *     tree's lifecycle: it runs setup before the engine (setup may need a
 *     source) and diffs the tree after it (none of these files may leak into
 *     the change set). An engine never writes them.
 *   - **Harness configuration** — whatever lives outside the tree: a system
 *     prompt, a skills plugin, a transient config home. Each engine compiles
 *     that from the spec itself, because each harness takes it differently.
 *
 * Every field is optional, and a spec carrying none of them runs exactly as it
 * did before they existed.
 */

/** One file's content. Text is UTF-8 unless `encoding` says otherwise. */
export interface EnvironmentFile {
  /** Relative path (to the workdir, or to a skill's own directory). */
  path: string
  content: string
  encoding?: "utf8" | "base64"
}

/** Instructions handed to every harness on top of its own defaults. */
export interface RunInstructions {
  /** System-level instructions: the harness's system prompt or nearest equivalent. */
  system?: string
  /** The workdir root's `AGENTS.md`, merged ahead of the workspace's own if it has one. */
  agentsMd?: string
}

/**
 * An Agent Skill: a directory whose `SKILL.md` (with `name` / `description`
 * frontmatter) says when and how to use it, plus any files it refers to.
 */
export interface RunSkill {
  /** Lowercase letters, digits and hyphens; also the directory name. */
  name: string
  /** Paths relative to the skill's directory; must include `SKILL.md`. */
  files: EnvironmentFile[]
}

/**
 * A run input that is not workspace content. Only `inline` exists today; a
 * kind this kernel does not know fails the run rather than being skipped.
 */
export type RunSource = { kind: "inline" } & EnvironmentFile

/** Where skills are materialized in the workdir: the cross-harness convention. */
export const SKILLS_DIR = ".agents/skills"

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const AGENTS_MD = "AGENTS.md"
/** Separates environment instructions from the workspace's own `AGENTS.md`. */
const MERGE_SEPARATOR = "\n\n"

/** Whether the spec carries any environment field at all. */
export function hasEnvironment(
  spec: Pick<RunSpec, "instructions" | "agentFiles" | "skills" | "sources">,
): boolean {
  return (
    Boolean(spec.instructions?.system || spec.instructions?.agentsMd) ||
    (spec.agentFiles?.length ?? 0) > 0 ||
    (spec.skills?.length ?? 0) > 0 ||
    (spec.sources?.length ?? 0) > 0
  )
}

/**
 * What {@link MaterializedEnvironment.restore} could not undo: files the
 * harness changed after they were written, kept as the harness left them.
 */
export interface RestoreReport {
  kept: string[]
}

/** The environment as written into a workdir, and the way to take it back out. */
export interface MaterializedEnvironment {
  /** Every workdir-relative path written or merged, in write order. */
  paths: string[]
  /**
   * Return the tree to how it was: created files removed, merged files back to
   * their original content, created directories removed when empty. A file the
   * harness rewrote is left alone and reported, never clobbered — its new
   * content is the run's work. Call it before computing a change set.
   */
  restore(): Promise<RestoreReport>
}

type Plan = {
  rel: string
  abs: string
  content: Buffer
  /** `merge` may land ahead of an existing file; `create` may not overwrite one. */
  mode: "merge" | "create"
}

type Applied =
  | { kind: "created"; rel: string; abs: string; content: Buffer }
  | { kind: "merged"; rel: string; abs: string; prefix: Buffer; original: Buffer }

/**
 * Write the spec's workdir-bound environment into `spec.workdir`:
 *
 *   - `instructions.agentsMd` → `AGENTS.md` at the root;
 *   - `agentFiles` → nested `AGENTS.md` files;
 *   - `skills` → `.agents/skills/<name>/…`;
 *   - `sources` → their own paths.
 *
 * An instruction file that already exists keeps its content after the
 * environment's, so a workspace's own conventions still apply. A skill or
 * source must not overwrite anything: that collision fails, because silently
 * replacing a workspace file with a run input would put the input in the
 * change set.
 *
 * Everything is validated before anything is written, so a bad spec leaves the
 * tree untouched. Paths must stay inside the workdir and may not pass through a
 * symlink — a snapshot can carry one, and writing through it would leave the
 * sandbox.
 */
export async function materializeEnvironment(
  spec: Pick<RunSpec, "workdir" | "instructions" | "agentFiles" | "skills" | "sources">,
): Promise<MaterializedEnvironment> {
  const plan = planEnvironment(spec)
  const applied: Applied[] = []
  const createdDirs: string[] = []
  try {
    for (const entry of plan) {
      await assertNoSymlink(spec.workdir, entry.rel)
      const existing = await readExisting(entry.abs, entry.rel)
      if (existing !== undefined && entry.mode === "create") {
        throw new Error(`environment file would overwrite a workspace file: ${entry.rel}`)
      }
      createdDirs.push(...(await mkdirTracked(spec.workdir, path.dirname(entry.abs))))
      if (existing === undefined) {
        await writeFile(entry.abs, entry.content, { flag: "wx" })
        applied.push({ kind: "created", rel: entry.rel, abs: entry.abs, content: entry.content })
      } else {
        const prefix = Buffer.concat([entry.content, Buffer.from(MERGE_SEPARATOR)])
        await writeFile(entry.abs, Buffer.concat([prefix, existing]))
        applied.push({ kind: "merged", rel: entry.rel, abs: entry.abs, prefix, original: existing })
      }
    }
  } catch (err) {
    // Half an environment is worse than none: undo what was written.
    await undo(applied, createdDirs)
    throw err
  }
  return {
    paths: applied.map((a) => a.rel),
    restore: () => undo(applied, createdDirs),
  }
}

/** The validated write list, or a throw naming the first problem. */
function planEnvironment(
  spec: Pick<RunSpec, "workdir" | "instructions" | "agentFiles" | "skills" | "sources">,
): Plan[] {
  const plan: Plan[] = []
  const seen = new Set<string>()
  const add = (
    rel: string,
    file: Pick<EnvironmentFile, "content" | "encoding">,
    mode: Plan["mode"],
  ) => {
    const normalized = normalizeRel(rel)
    if (seen.has(normalized)) throw new Error(`environment writes ${normalized} twice`)
    seen.add(normalized)
    plan.push({
      rel: normalized,
      abs: resolveWithin(spec.workdir, normalized),
      content: decode(file, normalized),
      mode,
    })
  }

  if (spec.instructions?.agentsMd) add(AGENTS_MD, { content: spec.instructions.agentsMd }, "merge")

  for (const file of spec.agentFiles ?? []) {
    if (path.posix.basename(normalizeRel(file.path)) !== AGENTS_MD) {
      throw new Error(`agent file must be named ${AGENTS_MD}: ${file.path}`)
    }
    add(file.path, file, "merge")
  }

  for (const skill of spec.skills ?? []) {
    if (!SKILL_NAME.test(skill.name)) {
      throw new Error(`skill name must match ${SKILL_NAME.source}: ${JSON.stringify(skill.name)}`)
    }
    if (!skill.files.some((f) => normalizeRel(f.path) === "SKILL.md")) {
      throw new Error(`skill ${skill.name} has no SKILL.md`)
    }
    for (const file of skill.files) {
      add(path.posix.join(SKILLS_DIR, skill.name, normalizeRel(file.path)), file, "create")
    }
  }

  for (const source of spec.sources ?? []) {
    const kind = (source as { kind?: unknown }).kind
    if (kind !== "inline") {
      throw new Error(`unsupported source kind ${JSON.stringify(kind)}`)
    }
    add(source.path, source, "create")
  }
  return plan
}

/** A relative POSIX path with no `.`/`..` segments, or a throw. */
function normalizeRel(rel: string): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) {
    throw new Error(`invalid environment path: ${JSON.stringify(rel)}`)
  }
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) {
    throw new Error(`environment path must be relative: ${rel}`)
  }
  const normalized = path.posix.normalize(rel)
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`environment path escapes the workdir: ${rel}`)
  }
  return normalized
}

function decode(file: Pick<EnvironmentFile, "content" | "encoding">, rel: string): Buffer {
  if (typeof file.content !== "string") throw new Error(`environment file ${rel} has no content`)
  if (file.encoding === undefined || file.encoding === "utf8") return Buffer.from(file.content)
  if (file.encoding === "base64") return Buffer.from(file.content, "base64")
  throw new Error(`environment file ${rel} has unknown encoding ${JSON.stringify(file.encoding)}`)
}

/** Throws when any existing segment of `rel` under `workdir` is a symlink. */
async function assertNoSymlink(workdir: string, rel: string): Promise<void> {
  let current = path.resolve(workdir)
  for (const segment of rel.split("/")) {
    current = path.join(current, segment)
    const st = await lstat(current).catch(() => undefined)
    if (!st) return
    if (st.isSymbolicLink()) throw new Error(`environment path passes through a symlink: ${rel}`)
  }
}

async function readExisting(abs: string, rel: string): Promise<Buffer | undefined> {
  const st = await lstat(abs).catch(() => undefined)
  if (!st) return undefined
  if (!st.isFile()) throw new Error(`environment path is not a regular file: ${rel}`)
  return readFile(abs)
}

/** `mkdir -p`, returning the directories it created (shallowest first). */
async function mkdirTracked(workdir: string, dir: string): Promise<string[]> {
  const created: string[] = []
  const base = path.resolve(workdir)
  const missing: string[] = []
  for (let d = dir; d !== base && d.startsWith(base + path.sep); d = path.dirname(d)) {
    const st = await lstat(d).catch(() => undefined)
    if (st) break
    missing.unshift(d)
  }
  for (const d of missing) {
    await mkdir(d)
    created.push(d)
  }
  return created
}

async function undo(applied: Applied[], createdDirs: string[]): Promise<RestoreReport> {
  const kept: string[] = []
  for (const entry of [...applied].reverse()) {
    const current = await readFile(entry.abs).catch(() => undefined)
    if (current === undefined) continue
    if (entry.kind === "created") {
      if (current.equals(entry.content)) await rm(entry.abs, { force: true })
      else kept.push(entry.rel)
    } else if (current.subarray(0, entry.prefix.length).equals(entry.prefix)) {
      // Our block is still on top: take it off, keeping anything the harness
      // changed below it.
      await writeFile(entry.abs, current.subarray(entry.prefix.length))
    } else {
      kept.push(entry.rel)
    }
  }
  for (const dir of [...createdDirs].reverse()) {
    await rmdir(dir).catch(() => undefined)
  }
  applied.length = 0
  createdDirs.length = 0
  return { kept }
}

/**
 * Write skills as `<dir>/<name>/…` in a directory the caller owns outside the
 * workdir (a harness's plugin or config home), with the same validation
 * {@link materializeEnvironment} applies. Nothing to restore: the caller
 * deletes `dir` itself.
 */
export async function writeSkills(dir: string, skills: RunSkill[]): Promise<void> {
  const plan = planEnvironment({ workdir: dir, skills })
  for (const entry of plan) {
    // planEnvironment lays skills out under SKILLS_DIR; here they sit at the root.
    const rel = path.posix.relative(SKILLS_DIR, entry.rel)
    const abs = resolveWithin(dir, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, entry.content, { flag: "wx" })
  }
}

/**
 * The skills index an engine without native skill discovery puts in front of
 * the model: one line per skill with where its `SKILL.md` was materialized and
 * what its frontmatter says it is for. Undefined when the run has no skills.
 */
export function skillsIndex(skills: RunSkill[] | undefined): string | undefined {
  if (!skills || skills.length === 0) return undefined
  const lines = skills.map((skill) => {
    const md = skill.files.find((f) => normalizeRel(f.path) === "SKILL.md")
    const description = md
      ? frontmatterField(decode(md, "SKILL.md").toString(), "description")
      : undefined
    return `- ${skill.name} (${SKILLS_DIR}/${skill.name}/SKILL.md)${description ? `: ${description}` : ""}`
  })
  return [
    "## Skills",
    "Each skill is a directory in the workspace. Before doing a task a skill covers, read",
    "its SKILL.md and follow it.",
    ...lines,
  ].join("\n")
}

/** A single-line scalar from a Markdown file's YAML frontmatter, if present. */
export function frontmatterField(markdown: string, field: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return undefined
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv || kv[1] !== field) continue
    const value = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")
    // A block scalar (`>` / `|`) spans lines this reader does not parse.
    return value === "" || value === ">" || value === "|" ? undefined : value
  }
  return undefined
}

/**
 * The instructions block an engine hands its harness, from whichever of these
 * the harness cannot already find on disk: the system instructions, the root
 * `AGENTS.md` text (for a harness that does not read `AGENTS.md`), and the
 * skills index (for one without skill discovery). Undefined when empty, so a
 * spec without an environment adds nothing.
 */
export function environmentInstructions(
  spec: Pick<RunSpec, "instructions" | "skills">,
  include: { agentsMd: boolean; skillsIndex: boolean },
): string | undefined {
  const parts = [
    spec.instructions?.system,
    include.agentsMd ? spec.instructions?.agentsMd : undefined,
    include.skillsIndex ? skillsIndex(spec.skills) : undefined,
  ].filter((p): p is string => typeof p === "string" && p.trim() !== "")
  return parts.length > 0 ? parts.join("\n\n") : undefined
}
