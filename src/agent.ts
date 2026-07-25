import type { AgentMessage, Provider, ToolResult } from "./providers/types.js"
import type { Tool } from "./tools/registry.js"

export interface RunAgentOptions {
  provider: Provider
  system: string
  userPrompt: string
  tools: Tool[]
  maxSteps?: number
  /**
   * Wall-clock budget for the whole loop in ms. Checked between steps; when
   * exceeded the loop stops cleanly and returns what's accumulated (with a note)
   * rather than throwing. Defaults to `RUNNER_RUN_TIMEOUT_MS` if set, else 10min.
   */
  maxDurationMs?: number
  log?: (line: string) => void
}

const DEFAULT_MAX_STEPS = 12
const FALLBACK_MAX_DURATION_MS = 10 * 60 * 1000

/** Resolve the wall-clock run budget from env, falling back to 10 minutes. */
function defaultMaxDurationMs(): number {
  const raw = Number(process.env.RUNNER_RUN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_MAX_DURATION_MS
}
const FALLBACK_MAX_TOOL_RESULT_BYTES = 64 * 1024

/**
 * Cap on tool output fed back into the conversation, independent of the sandbox
 * buffer caps — an 8 MB stdout would otherwise blow the context window.
 * Env-overridable (`RUNNER_MAX_TOOL_RESULT_BYTES`, default 64 KiB) and resolved
 * per call so a changed env takes effect without a reload.
 */
export function maxToolResultBytes(): number {
  const raw = Number(process.env.RUNNER_MAX_TOOL_RESULT_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FALLBACK_MAX_TOOL_RESULT_BYTES
}

function truncate(text: string, max = maxToolResultBytes()): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]`
}

/**
 * Drives a provider-agnostic tool-use loop: the model converses, the runner
 * executes any requested tools in the sandbox, feeds the results back, and
 * repeats until the model stops calling tools (or the step budget is hit). The
 * model orchestrates; deterministic work happens in the tools.
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
  const { provider, system, userPrompt, tools } = options
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const maxDurationMs = options.maxDurationMs ?? defaultMaxDurationMs()
  const log = options.log ?? (() => {})

  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  const specs = tools.map((t) => t.spec)
  const messages: AgentMessage[] = [{ role: "user", text: userPrompt }]

  const deadline = Date.now() + maxDurationMs
  let finalText = ""
  let lastAssistantText = ""
  let exhausted = false
  let timedOut = false

  for (let step = 0; step < maxSteps; step += 1) {
    // Wall-clock budget: enforced between steps so an in-flight provider/tool
    // call isn't interrupted mid-flight, mirroring how maxSteps stops cleanly.
    // Because the check is only between steps, a single step can overshoot the
    // budget by its entire duration: up to (provider timeout × maxRetries) for the
    // converse call plus the time to execute all of that step's tool calls. So the
    // effective ceiling is `maxDurationMs + one full step`, not `maxDurationMs`.
    if (Date.now() >= deadline) {
      timedOut = true
      log(`reached run time budget (${maxDurationMs}ms) after ${step} step(s)`)
      break
    }
    const turn = await provider.converse({ system, messages, tools: specs })
    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls })
    if (turn.text) lastAssistantText = turn.text

    if (turn.toolCalls.length === 0) {
      finalText = turn.text
      break
    }

    const results: ToolResult[] = []
    for (const call of turn.toolCalls) {
      const tool = byName.get(call.name)
      if (!tool) {
        results.push({ toolCallId: call.id, content: `unknown tool: ${call.name}`, isError: true })
        log(`tool ${call.name} (unknown)`)
        continue
      }
      try {
        const output = await tool.execute(call.input)
        results.push({ toolCallId: call.id, content: truncate(output) })
        log(`tool ${call.name} ok (${output.length} bytes)`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ toolCallId: call.id, content: message, isError: true })
        log(`tool ${call.name} error: ${message}`)
      }
    }
    messages.push({ role: "tool", results })

    if (step === maxSteps - 1) exhausted = true
  }

  // Ran out of time mid-loop: don't spend more of the (already-blown) budget on
  // a summary call — just return whatever prose we accumulated, clearly noted.
  if (!finalText && timedOut) {
    const accumulated = lastAssistantText || "(no output before time budget exhausted)"
    return `${accumulated}\n\n[run stopped: wall-clock budget of ${maxDurationMs}ms exceeded]`
  }

  // Hit the step budget mid-tool-use: ask once more with no tools so the model
  // can summarize, falling back to its last prose rather than losing the work.
  if (!finalText && exhausted) {
    log(`reached max steps (${maxSteps}); requesting a final summary`)
    try {
      const summary = await provider.converse({ system, messages, tools: [] })
      finalText = summary.text || lastAssistantText
    } catch (err) {
      log(`final summary failed: ${err instanceof Error ? err.message : String(err)}`)
      finalText = lastAssistantText
    }
  }

  return finalText || "(no output)"
}
