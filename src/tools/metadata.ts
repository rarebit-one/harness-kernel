import type { ToolSpec } from "../providers/types.js"
import type { Tool } from "./registry.js"

/**
 * Generic tool metadata and the projections that narrow it.
 *
 * A tool descriptor carries more than a model needs to call it: who may see it,
 * whether it needs confirmation, whether it can be undone, how long its result
 * should be kept. None of that belongs in the JSON schema handed to a provider —
 * so the metadata is rich and the **projection** to a provider is deliberately
 * lossy.
 *
 * The metadata here is only ever *descriptive*. The kernel records that a tool
 * says `requiresConfirmation`; it never implements a confirmation flow, because
 * what confirmation means — a modal, a Slack approval, a second agent — is the
 * application's decision. Same for undo and retention. Policy lives in the app
 * layer; the vocabulary lives here so every layer agrees on the words.
 */

/**
 * How a turn was invoked. A tool whose surface differs by invocation path
 * declares the modes it participates in, and resolution filters by the turn's
 * mode.
 *
 *   - `user_initiated`   — a normal user-driven turn.
 *   - `system_initiated` — a turn fired by a trigger, bypassing the user.
 */
export type InvocationMode = "user_initiated" | "system_initiated"

/** How long a tool's result should be retained by the caller. */
export type ResultRetention = "ephemeral" | "standard" | "persistent"

/**
 * Whether a tool's raw output reaches the client. `suppressed` trims it from
 * client-facing envelopes while the model still receives it unchanged — for
 * tools whose output is the model's working data, not a user-facing payload.
 */
export type ClientResultVisibility = "full" | "suppressed"

/**
 * Optional descriptive metadata on a {@link Tool}. Every field is optional and
 * an absent field always means "no restriction", so a tool that declares no
 * metadata behaves exactly as it did before this existed.
 */
export interface ToolMetadata {
  /** Human-facing label, where a UI wants something friendlier than `name`. */
  displayName?: string
  /**
   * Capability scoping. When set, only the listed capabilities see the tool;
   * absent or null means every capability does.
   */
  targetCapabilities?: string[] | null
  /**
   * Invocation-mode scoping. When set, the tool is visible only in the listed
   * modes; absent or null means mode-agnostic. A tool that declares modes is
   * hidden from an unscoped resolution, so a system-only tool can never leak
   * into a user-driven loop.
   */
  invocationModes?: InvocationMode[] | null
  /** The caller should confirm with a human before executing. */
  requiresConfirmation?: boolean
  /** The effect can be undone. */
  reversible?: boolean
  /** The tool that undoes this one, when `reversible`. */
  undoToolName?: string | null
  /** How long undo stays available. */
  undoWindowSeconds?: number | null
  resultRetention?: ResultRetention
  clientResultVisibility?: ClientResultVisibility
}

/** The scope a tool surface is being resolved for. */
export interface ToolSelection {
  /** Resolving capability; matched against `targetCapabilities`. */
  capability?: string
  /** Invocation mode of the turn; matched against `invocationModes`. */
  mode?: InvocationMode
  /** Allowlist of tool names, e.g. from a workflow's permissions. */
  allowed?: string[]
}

/** Whether one tool is visible under a selection. */
export function isToolVisible(tool: Tool, selection: ToolSelection = {}): boolean {
  const meta = tool.meta
  if (selection.allowed && !selection.allowed.includes(tool.spec.name)) return false
  if (!meta) return true

  // A tool scoped to specific capabilities is hidden unless one matches. An
  // unscoped resolution (no capability given) cannot satisfy the scope, so the
  // tool stays hidden — scoping fails closed.
  if (meta.targetCapabilities && meta.targetCapabilities.length > 0) {
    if (!selection.capability || !meta.targetCapabilities.includes(selection.capability)) {
      return false
    }
  }

  if (meta.invocationModes && meta.invocationModes.length > 0) {
    if (!selection.mode || !meta.invocationModes.includes(selection.mode)) return false
  }

  return true
}

/**
 * Narrow a tool surface to what a given capability and invocation mode may see.
 * This is the projection that runs *before* the model ever hears about a tool.
 */
export function selectTools(tools: Tool[], selection: ToolSelection = {}): Tool[] {
  return tools.filter((tool) => isToolVisible(tool, selection))
}

/**
 * Project tools down to the provider-facing definitions — name, description and
 * input schema, and nothing else. Everything the metadata adds is intentionally
 * dropped here: a model has no use for retention policy, and leaking it into
 * the schema would only spend context.
 */
export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((tool) => tool.spec)
}

/** Tools that must not execute until a human has approved them. */
export function toolsRequiringConfirmation(tools: Tool[]): Tool[] {
  return tools.filter((tool) => tool.meta?.requiresConfirmation === true)
}

/** Look up the tool that undoes `name`, when one is declared and reversible. */
export function undoToolFor(tools: Tool[], name: string): Tool | undefined {
  const tool = tools.find((t) => t.spec.name === name)
  if (!tool?.meta?.reversible || !tool.meta.undoToolName) return undefined
  return tools.find((t) => t.spec.name === tool.meta?.undoToolName)
}
