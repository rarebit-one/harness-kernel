import type { AgentMessage, ToolCall, ToolResult } from "./providers/types.js"

/** A user turn as the loop's history carries it. */
export type UserTurn = Extract<AgentMessage, { role: "user" }>

/** How {@link settleMessages} answers a tool call that has no result. */
export interface SettleOptions {
  /**
   * The result for an unanswered call. The helper sets `toolCallId` itself.
   * Absent, each call gets a neutral error result saying it was not run; pass
   * one to say something else (`rejected: true` for a parked call the caller
   * declined, say).
   */
  answer?: (call: ToolCall) => Omit<ToolResult, "toolCallId">
}

/** The result an unanswered call gets when the caller chose none. */
function unanswered(): Omit<ToolResult, "toolCallId"> {
  return { content: "not run: the turn ended before this tool call was answered", isError: true }
}

/**
 * A transcript in which every tool call has a result, ready to be continued.
 *
 * A stored transcript can end on calls nobody answered: a run that suspended
 * on an external call the caller then abandoned, or a transcript an
 * application built or cut itself. Every provider rejects a tool call with no
 * result, wherever it sits in the history, so each assistant turn's missing
 * results are added here: into the tool turn that follows it when there is
 * one (one tool turn answers one assistant turn, as `withToolResults` keeps
 * it), else as a new tool turn straight after it. Calls that already have a
 * result are left alone, so settling twice changes nothing.
 *
 * A tool turn that answers no call (one that does not follow an assistant
 * turn, or a result for a call id that turn never made) is thrown on rather
 * than dropped: the loop never writes one, so it means the transcript was
 * damaged, and rewriting what the model was shown would hide that.
 *
 * The output ends with whatever the input ended with, now whole; it is a
 * valid seed when that is a user message or a tool turn. Use
 * {@link withUserTurn} to append the next user message. Neither array is
 * mutated; untouched messages are shared with the input.
 */
export function settleMessages(
  messages: AgentMessage[],
  options: SettleOptions = {},
): AgentMessage[] {
  const answer = options.answer ?? unanswered
  const settled: AgentMessage[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role === "tool") {
      // Every tool turn that follows an assistant turn is consumed below, so
      // one reached here answers nothing.
      throw new Error(
        `transcript message ${i} is a tool turn that does not follow an assistant turn, ` +
          "so its results answer no call",
      )
    }
    settled.push(message)
    if (message.role !== "assistant" || message.toolCalls.length === 0) continue

    const next = messages[i + 1]
    const given = next?.role === "tool" ? next.results : []
    const asked = new Set(message.toolCalls.map((c) => c.id))
    const stray = given.filter((r) => !asked.has(r.toolCallId)).map((r) => r.toolCallId)
    if (stray.length > 0) {
      throw new Error(
        `transcript message ${i + 1} answers call id(s) the assistant turn before it never made: ` +
          stray.join(", "),
      )
    }
    const answered = new Set(given.map((r) => r.toolCallId))
    const missing = message.toolCalls.filter((c) => !answered.has(c.id))
    if (next?.role === "tool") i += 1
    if (next?.role === "tool" && missing.length === 0) {
      settled.push(next)
      continue
    }
    settled.push({
      role: "tool",
      results: [...given, ...missing.map((call) => ({ ...answer(call), toolCallId: call.id }))],
    })
  }
  return settled
}

/**
 * The seed for the next user turn: `messages` settled (see
 * {@link settleMessages}), then `turn` appended. The result always passes the
 * loop's seed check. A string is the turn's text; an object is the turn
 * without its `role`.
 *
 * This prepares the transcript and nothing else. What the next run may spend
 * is the caller's policy: pass fresh limits for a per-turn budget, or
 * `remainingLimits(limits, consumed)` to carry one budget across turns.
 */
export function withUserTurn(
  messages: AgentMessage[],
  turn: string | Omit<UserTurn, "role">,
  options: SettleOptions = {},
): AgentMessage[] {
  const user: UserTurn =
    typeof turn === "string" ? { role: "user", text: turn } : { ...turn, role: "user" }
  return [...settleMessages(messages, options), user]
}
