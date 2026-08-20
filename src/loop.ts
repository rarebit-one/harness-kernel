/**
 * Extension point 7 — the control loop itself.
 *
 * Every other seam in this kernel answers "which implementation?" for something
 * the loop *uses*: a model, a route, a context source, a tool. The loop that
 * ties them together was the one piece an application could not replace, so
 * anything that needed different control flow — a plan-then-execute shape, a
 * loop that pauses on `ToolMetadata.requiresConfirmation`, a loop that fans a
 * step out to subagents — had to fork {@link runAgent} and inherit every future
 * fix by hand.
 *
 * That gap is not hypothetical: `ToolMetadata` already declares
 * `requiresConfirmation`, and `toolsRequiringConfirmation()` already selects
 * for it, but a confirmation flow has to interpose between "the model asked for
 * this tool" and "the tool ran" — the exact seam that did not exist. The
 * metadata described a control-flow decision the kernel gave no way to make.
 *
 * The kernel still ships exactly one loop, `nativeLoop`, and it is the same
 * code that has always run. This adds the interface around it, not an
 * alternative to it.
 */

import { runNativeLoop } from "./agent.js"
import type { RunEventSink, RunOutcome } from "./events.js"
import type { ChatModel } from "./models/chat.js"
import type { Tool } from "./tools/registry.js"

/**
 * One run's materials, resolved.
 *
 * Everything here is already decided: the model is bound (registry-resolved and
 * middleware-wrapped if it was going to be), the prompts are built, the tool
 * surface is projected, the budgets are numbers rather than optionals. A loop
 * decides *control flow* and nothing else — which is what keeps a second
 * implementation small enough to be worth writing.
 */
export interface LoopRequest {
  model: ChatModel
  system: string
  userPrompt: string
  tools: Tool[]
  limits: { maxSteps: number; maxDurationMs: number }
}

/**
 * What a loop is given to talk to the outside world. Both are the same channels
 * the rest of the kernel uses, so a loop needs no privileged access.
 *
 * A loop that emits should build its own emitter — `runEventEmitter(ctx.emit,
 * ctx.log)` — rather than calling the sink directly: `seq` and `at` are the
 * emitter's to stamp, and that is what keeps one run's sequence gapless and its
 * sink failures non-fatal regardless of who is looping.
 */
export interface LoopContext {
  log: (line: string) => void
  emit?: RunEventSink
}

/**
 * What a loop returns.
 *
 * Richer than {@link runAgent}'s bare string on purpose: `outcome` and `steps`
 * are facts the loop alone knows, and a caller that had to infer "did this
 * finish or did it run out of budget?" from the prose would be guessing. The
 * same two values appear on the `run.finished` event, and they must agree —
 * the event stream and the return value are two views of one run, never two
 * sources of truth.
 */
export interface LoopResult {
  text: string
  steps: number
  /**
   * Why the run stopped. The native loop never *returns* `"failed"` — that path
   * throws, and the terminal event is emitted before the error propagates. The
   * value is in the union because a custom loop may legitimately choose to
   * report a failure rather than throw one.
   */
  outcome: RunOutcome
}

/**
 * A pluggable control loop. Implementations: the native tool-use loop, or an
 * application's own.
 *
 * `name` exists for the same reason `AgentEngine.name` does — so a log line or
 * an event can say which one ran. There is deliberately no `supports()`: a loop
 * is handed materials that are already resolved, so there is no capability for
 * it to refuse. An engine still refuses through its own `supports()`.
 */
export interface Loop {
  readonly name: string
  run(req: LoopRequest, ctx: LoopContext): Promise<LoopResult>
}

/**
 * The kernel's one loop: the provider-neutral tool-use loop that `runAgent` has
 * always run, behind the interface.
 *
 * This is the same code path, not a reimplementation — `runAgent` and
 * `nativeLoop` both delegate to it, so there is no second behaviour to keep in
 * sync and no way for the two to drift.
 */
export const nativeLoop: Loop = {
  name: "native",
  run: (req, ctx) => runNativeLoop(req, ctx),
}
