import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { IssueEntry, KnowledgeEntry } from "../types.js"

/**
 * The standing, workspace-scoped authority the runner grants an in-run agent —
 * uniformly, regardless of engine. It is bound to exactly ONE run: that run's
 * workspace id, its sandbox working tree, and the per-run sinks whose contents
 * ride the run-result callback (the runner's own trusted, per-run credentialled
 * channel to the control plane, see worker.ts) and are applied there through the
 * existing IssueRecorder / KnowledgePromoter / change-set commit — honoring the
 * workflow's approval gate.
 *
 * The agent can NEVER name another workspace: the context is fixed at
 * construction and every capability defensively rejects a mismatching
 * `workspace_id`. And the surface is exactly three tools — it never exposes the
 * control-plane MCP's privileged operations (run_workflow, create_workspace,
 * add_*_member, …). Those two invariants are the security contract asserted by
 * capability.test.ts.
 */
export interface CapabilityContext {
  /** The one workspace this authority is scoped to (the run's own). */
  workspaceId: string
  /** The run's sandbox working tree; write_file lands here → captured by the change set. */
  workdir: string
  /** Issues the run opened; delivered via RunResult.issues[] → IssueRecorder. */
  issues: IssueEntry[]
  /** Knowledge the run promoted; delivered via RunResult.knowledge[] → KnowledgePromoter. */
  knowledge: KnowledgeEntry[]
}

/** The uniform result of a capability call, JSON-encoded back to the agent. */
export interface CapabilityResult {
  ok: boolean
  error?: string
}

/**
 * A transport-neutral capability: name + description + a Zod raw shape (the
 * advertised input schema) + a handler over RAW input. The handler — not the
 * transport — is the security boundary: it does its own coercion and enforces
 * the workspace scope, so the guarantees hold identically whether the tool is
 * reached via the Claude Code SDK MCP server, a codex `config.toml` stdio server,
 * or a direct call in a test.
 */
export interface CapabilityTool {
  name: string
  description: string
  /** Zod raw shape advertised to the model; note it deliberately omits `workspace_id`. */
  schema: z.ZodRawShape
  handler(input: Record<string, unknown>): Promise<CapabilityResult>
}

/** The exact, fixed set of capability names — asserted by the security spec. */
export const CAPABILITY_TOOL_NAMES = ["open_issue", "write_file", "promote_knowledge"] as const

const str = (v: unknown): string => (typeof v === "string" ? v : "")
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * Reject any call that names a workspace other than the one this authority is
 * bound to. `workspace_id` is NOT part of any tool's advertised schema, so a
 * well-behaved agent never sends it; this is defense-in-depth against a
 * programmatic or adversarial caller trying to redirect an emit cross-workspace.
 * Returns an error result to short-circuit, or null when the call may proceed.
 */
function denyCrossWorkspace(
  input: Record<string, unknown>,
  workspaceId: string,
): CapabilityResult | null {
  for (const key of ["workspace_id", "workspaceId"]) {
    const v = input[key]
    if (typeof v === "string" && v !== workspaceId) {
      return { ok: false, error: `cross-workspace operation denied (bound to ${workspaceId})` }
    }
  }
  return null
}

/** Lexical guard: refuse a relative path that escapes the sandbox via `..` or is absolute. */
function resolveWithin(dir: string, relPath: string): string {
  const base = path.resolve(dir)
  const target = path.resolve(base, relPath)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes sandbox: ${relPath}`)
  }
  return target
}

/**
 * Build the three capability tools bound to one run's {@link CapabilityContext}.
 * This is the single source of truth every engine shares; the MCP hosting
 * adapters (SDK for Claude Code, stdio for codex) are thin transports over it.
 */
export function capabilityTools(ctx: CapabilityContext): CapabilityTool[] {
  return [
    {
      name: "open_issue",
      description:
        "Open a workspace issue — the 'a human should look at this' surface (a decision sheet, a " +
        "finding, a chase item). Filed after the run completes, in THIS run's workspace only. Pass a " +
        "stable `dedupe_key` so a re-run UPDATES the same issue instead of opening a duplicate.",
      schema: {
        title: z.string().describe("Short issue title."),
        body: z.string().optional().describe("Issue body (markdown)."),
        dedupe_key: z
          .string()
          .optional()
          .describe("Stable key so re-runs upsert one rolling issue rather than duplicating."),
        labels: z.array(z.string()).optional().describe("Optional labels."),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- async by tool contract; resolves synchronously
      handler: async (input) => {
        const denied = denyCrossWorkspace(input, ctx.workspaceId)
        if (denied) return denied
        const title = str(input.title)
        if (!title) return { ok: false, error: "title is required" }
        const entry: IssueEntry = { title }
        if (str(input.body)) entry.body = str(input.body)
        if (str(input.dedupe_key)) entry.dedupe_key = str(input.dedupe_key)
        const labels = strArray(input.labels)
        if (labels.length > 0) entry.labels = labels
        ctx.issues.push(entry)
        return { ok: true }
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 file into THIS run's workspace sandbox (creating parent directories). The " +
        "change is captured in the run's change set and committed to the workspace after the run, " +
        "honoring the approval gate. Paths are relative to the workspace root; escaping it is refused.",
      schema: {
        path: z.string().describe("Workspace-relative file path."),
        content: z.string().describe("UTF-8 file content."),
      },
      handler: async (input) => {
        const denied = denyCrossWorkspace(input, ctx.workspaceId)
        if (denied) return denied
        const rel = str(input.path)
        if (!rel) return { ok: false, error: "path is required" }
        if (typeof input.content !== "string") return { ok: false, error: "content is required" }
        let target: string
        try {
          target = resolveWithin(ctx.workdir, rel)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, input.content)
        return { ok: true }
      },
    },
    {
      name: "promote_knowledge",
      description:
        "Record a durable piece of workspace knowledge/memory learned during this run (a preference, " +
        "decision, fact, or reusable summary), promoted into THIS run's workspace after it completes " +
        "(held for approval if the workflow requires it). Use sparingly, for genuinely reusable knowledge.",
      schema: {
        content: z.string().describe("The knowledge to record (markdown)."),
        title: z.string().optional().describe("Optional short title."),
        kind: z
          .string()
          .optional()
          .describe("Optional kind, e.g. 'memory' (default) or 'decision'."),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- async by tool contract; resolves synchronously
      handler: async (input) => {
        const denied = denyCrossWorkspace(input, ctx.workspaceId)
        if (denied) return denied
        const content = str(input.content)
        if (!content) return { ok: false, error: "content is required" }
        const entry: KnowledgeEntry = { content }
        if (str(input.title)) entry.title = str(input.title)
        if (str(input.kind)) entry.kind = str(input.kind)
        ctx.knowledge.push(entry)
        return { ok: true }
      },
    },
  ]
}
