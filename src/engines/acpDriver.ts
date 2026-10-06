import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@zed-industries/agent-client-protocol"
import { runStop, type StoppedBy } from "../signals.js"
import type { AcpClientEvents, AcpOptions, AcpOutcome } from "./acp.js"

/**
 * The outcome of a prompt turn that returned. A stop is credited only when the
 * agent actually answered `cancelled`: a stop that lands just after a clean
 * `end_turn` must not relabel a finished run as canceled or timed out.
 */
export function promptOutcome(stopReason: string, stoppedBy: StoppedBy | undefined): AcpOutcome {
  return stopReason === "cancelled" && stoppedBy ? { stopReason, stoppedBy } : { stopReason }
}

/** How long an agent gets to honour `session/cancel` before it is killed. */
const DEFAULT_CANCEL_GRACE_MS = 5_000

/**
 * The default ACP driver: the single integration boundary to an ACP agent
 * subprocess, mirroring `defaultCodexDriver`'s injectable shape. It spawns the
 * agent, wires an {@link ClientSideConnection} over its stdio via
 * {@link ndJsonStream}, and runs one ACP turn: `initialize` → `session/new`
 * (with the run's cwd + MCP servers) → `session/prompt`.
 *
 * The host `Client` it implements is deliberately minimal:
 *   - `sessionUpdate` accumulates `agent_message_chunk`s (the run's prose) and
 *     surfaces thoughts / tool-call titles to the log.
 *   - `requestPermission` AUTO-APPROVES (selects an `allow_*` option). This is
 *     the ACP equivalent of the codex driver's `--dangerously-bypass-approvals`
 *     and the Claude Code driver's `bypassPermissions`, justified the same way:
 *     an ACP agent only runs inside a throwaway ephemeral container, so the
 *     container — not an approval prompt — is the safety boundary.
 *   - No `readTextFile`/`writeTextFile`/terminal capability is advertised, so the
 *     agent edits `cwd` directly and the caller's change-set diff is the sole
 *     edit path (no second, protocol-level way for a file to change).
 *
 * Exercised only when the operator enables the agent (per-agent env flag) on the
 * ephemeral profile; every test injects a fake driver, so no binary/network is
 * touched in CI.
 */
export async function defaultAcpDriver(
  opts: AcpOptions,
  events: AcpClientEvents,
): Promise<AcpOutcome> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  // A spawn failure (e.g. the agent binary is absent) surfaces here; the awaited
  // protocol calls below then reject and we rethrow with the stderr tail.
  child.on("error", (err) => {
    stderr += `\n${String(err)}`
  })

  const client: Client = {
    // Not `async`: these return a resolved promise directly (the ACP `Client`
    // methods are `Promise`-typed, but there is nothing to await).
    sessionUpdate({ update }) {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") events.onAssistantChunk(update.content.text)
          break
        case "agent_thought_chunk":
          if (update.content.type === "text") events.onLog(`thought: ${update.content.text}`)
          break
        case "tool_call":
          events.onLog(`tool: ${update.title}`)
          break
        default:
          break
      }
      return Promise.resolve()
    },
    requestPermission({ options }) {
      const allow =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once")
      return Promise.resolve(
        allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } },
      )
    },
  }

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  const conn = new ClientSideConnection(() => client, stream)

  // The run's own timer merged with the caller's cancel. Once a session exists
  // the stop is a protocol-level `session/cancel` (the agent winds the turn
  // down and answers `cancelled`), with a bounded grace period: an agent that
  // is hung or ignores the cancel is killed, so a stop can never hang the run.
  // Before a session exists there is nothing to cancel, so it is killed at once.
  //
  // Every protocol await races `forced`, which rejects on a force-stop: a
  // killed agent never answers, and its pending requests would otherwise wait
  // forever.
  let sessionId = ""
  let forceTimer: NodeJS.Timeout | undefined
  let rejectForced: (err: Error) => void = () => {}
  const forced = new Promise<never>((_, reject) => {
    rejectForced = reject
  })
  forced.catch(() => {}) // observed via the races below; never unhandled
  const guarded = <T>(call: Promise<T>): Promise<T> => Promise.race([call, forced])
  const forceStop = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    rejectForced(new Error(`${opts.command}: agent force-stopped`))
  }
  const stop = runStop(opts.maxDurationMs, opts.signal)
  const onStop = (): void => {
    if (!sessionId) return forceStop()
    void conn.cancel({ sessionId }).catch(() => {})
    forceTimer = setTimeout(forceStop, opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS)
  }
  if (stop.signal?.aborted) onStop()
  else stop.signal?.addEventListener("abort", onStop, { once: true })

  try {
    await guarded(conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }))
    const session = await guarded(conn.newSession({ cwd: opts.cwd, mcpServers: opts.mcpServers }))
    sessionId = session.sessionId
    // A stop that landed while the session was being created killed nothing
    // yet (there was no session): honour it now rather than run the turn.
    const early = stop.stoppedBy()
    if (early) return { stopReason: "cancelled", stoppedBy: early }
    const res = await guarded(
      conn.prompt({ sessionId, prompt: [{ type: "text", text: opts.prompt }] }),
    )
    return promptOutcome(res.stopReason, stop.stoppedBy())
  } catch (err) {
    // A force-stop (or the kill-before-session path) rejects the pending
    // protocol call; that is the stop, not an agent failure.
    const stoppedBy = stop.stoppedBy()
    if (stoppedBy) return { stopReason: "cancelled", stoppedBy }
    if (stderr.trim()) {
      const tail = stderr.length > 4000 ? `…${stderr.slice(-4000)}` : stderr
      opts.log(`${opts.command} stderr:\n${tail}`)
    }
    throw err
  } finally {
    if (forceTimer) clearTimeout(forceTimer)
    stop.signal?.removeEventListener("abort", onStop)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}
