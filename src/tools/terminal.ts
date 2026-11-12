import type { ToolMetadata } from "./metadata.js"
import type { Tool } from "./registry.js"

export interface TerminalToolOptions {
  /** The name the model calls, e.g. `reply` or `final_answer`. */
  name: string
  description: string
  /** JSON Schema for the structured answer the model must produce. */
  inputSchema: Record<string, unknown>
  /** Any other metadata; `dispatch` is fixed to `"terminal"`. */
  meta?: Omit<ToolMetadata, "dispatch">
}

/**
 * A final-answer tool: calling it ends the loop, and the call's arguments are
 * the run's structured result (`ConversationResult.terminal.input`).
 *
 * This is how a conversational application gets a typed reply out of the loop
 * instead of parsing prose. The model is told the schema through the tool
 * definition, so the shape is enforced where models enforce shapes best. By
 * default the kernel does not check the arguments against the schema; a run
 * with `validateToolInput: true` does, and refuses a call that does not fit
 * before it can end the run, telling the model what to fix. A rule the schema
 * cannot express (one field required only when another has a given value) is
 * the caller's: supply your own `Tool` with `meta.dispatch: "terminal"` whose
 * executor throws on a bad answer, which sends the error back to the model and
 * lets it try again.
 *
 * The executor here is a no-op that acknowledges the call: a tool result still
 * has to be appended so the transcript carries no dangling tool call and can be
 * resumed on the next turn. For the same reason, any other tool calls the
 * model made in the same turn still execute, before or after this one in the
 * order it issued them; "final" means the loop ends after this turn, not that
 * this call pre-empts its siblings.
 */
export function terminalTool(options: TerminalToolOptions): Tool {
  return {
    spec: {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema,
    },
    meta: { ...options.meta, dispatch: "terminal" },
    execute: () => Promise.resolve("accepted"),
  }
}
