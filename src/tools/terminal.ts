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
 * definition, so the shape is enforced where models enforce shapes best. The
 * kernel does not validate the arguments against the schema (it ships no
 * JSON-Schema validator); a caller that needs validation runs it on
 * `terminal.input`, or supplies its own `Tool` with `meta.dispatch: "terminal"`
 * whose executor throws on a bad answer, which sends the error back to the
 * model and lets it try again.
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
