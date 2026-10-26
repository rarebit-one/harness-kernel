import type { RunSpec } from "./types.js"

/**
 * The task prompt an out-of-process harness (Claude Code, codex, an ACP agent)
 * is handed: the workflow prompt, the run's inputs, the caller's pre-assembled
 * context when there is any, and a closing instruction.
 *
 * These harnesses explore the working tree with their own tools, but that is no
 * reason to drop `spec.context`: it can carry material that is not on disk at
 * all (curated notes, assembled memory), which is exactly what the native loop
 * bakes into its own prompt. An empty context adds nothing, so a run without one
 * gets the prompt it always had.
 */
export function harnessPrompt(spec: RunSpec): string {
  const inputs = JSON.stringify(spec.inputs ?? {}, null, 2)
  const context = spec.context?.trim() ? ["## Workspace context", spec.context, ""] : []
  return [
    spec.workflow.prompt ?? `Execute the "${spec.workflow.name ?? spec.workflowPath}" workflow.`,
    "",
    "## Inputs",
    "```json",
    inputs,
    "```",
    "",
    ...context,
    "You are running as an autonomous workflow. The current working directory is the",
    "workspace — inspect and edit its files directly with your tools. When finished,",
    "reply with the workflow's output as Markdown.",
  ].join("\n")
}
