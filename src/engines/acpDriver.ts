import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@zed-industries/agent-client-protocol"
import type { AcpClientEvents, AcpOptions, AcpOutcome } from "./acp.js"

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

  let timedOut = false
  let sessionId = ""
  const timer =
    opts.maxDurationMs && opts.maxDurationMs > 0
      ? setTimeout(() => {
          timedOut = true
          if (sessionId) void conn.cancel({ sessionId }).catch(() => {})
        }, opts.maxDurationMs)
      : undefined

  try {
    await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await conn.newSession({ cwd: opts.cwd, mcpServers: opts.mcpServers })
    sessionId = session.sessionId
    const res = await conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    })
    return { stopReason: timedOut ? "cancelled" : res.stopReason }
  } catch (err) {
    if (stderr.trim()) {
      const tail = stderr.length > 4000 ? `…${stderr.slice(-4000)}` : stderr
      opts.log(`${opts.command} stderr:\n${tail}`)
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}
