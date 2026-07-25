import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

/**
 * The standing, workspace-scoped authority an engine grants an in-run agent,
 * uniformly regardless of engine. It is bound to exactly ONE run: that run's
 * workspace id and its sandbox working tree.
 *
 * The agent can NEVER name another workspace: the context is fixed at
 * construction and every capability defensively rejects a mismatching
 * `workspace_id`. That invariant is enforced here, by {@link denyCrossWorkspace}
 * and {@link resolveWithin}, and both are exported so an application building
 * its own capabilities inherits exactly the same guarantees rather than
 * reimplementing them slightly differently.
 *
 * The kernel defines only the capabilities that carry no product semantics
 * (currently {@link writeFileCapability}). What an application emits — an
 * issue, a piece of knowledge — is the application's vocabulary and lives
 * there, injected into the engines through their capability-tool seams.
 */
export interface CapabilityContext {
  /** The one workspace this authority is scoped to (the run's own). */
  workspaceId: string
  /** The run's sandbox working tree; write_file lands here → captured by the change set. */
  workdir: string
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

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/**
 * Reject any call that names a workspace other than the one this authority is
 * bound to. `workspace_id` is NOT part of any tool's advertised schema, so a
 * well-behaved agent never sends it; this is defense-in-depth against a
 * programmatic or adversarial caller trying to redirect an emit cross-workspace.
 * Returns an error result to short-circuit, or null when the call may proceed.
 */
export function denyCrossWorkspace(
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
export function resolveWithin(dir: string, relPath: string): string {
  const base = path.resolve(dir)
  const target = path.resolve(base, relPath)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes sandbox: ${relPath}`)
  }
  return target
}

/**
 * The generic sandbox-write capability: put a UTF-8 file into THIS run's working
 * tree. It stays in the kernel because it carries no product semantics — it
 * touches only the workspace scope and the workdir, and the change is picked up
 * by whatever diffs the tree afterwards. Nothing about it is specific to what a
 * given application does with the result.
 *
 * Application-specific capabilities (emitting an issue, promoting knowledge)
 * live in the application and are composed alongside this one — see
 * `capabilityToolsFor` on the engines.
 */
export function writeFileCapability(ctx: CapabilityContext): CapabilityTool {
  return {
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
  }
}
