import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CodexMessage, CodexOptions } from "./codex.js"

/**
 * The default codex driver: the single integration boundary to the OpenAI Codex
 * CLI, mirroring claudeCodeDriver's injectable shape. It runs codex
 * non-interactively (`codex exec`) against the prepared sandbox. The engine has
 * already written the run's MCP servers (connectors + the runner-hosted capability
 * server) into `config.toml` inside `opts.codexHome`; pointing the child at it via
 * the `CODEX_HOME` env var is how codex discovers them.
 *
 * Invocation (verified against the OpenAI Codex CLI reference, `codex exec`):
 *   - `-m <model>`            — model override
 *   - `-C <cwd>`              — workspace root
 *   - `--skip-git-repo-check` — the tarball sandbox is not a git repo; without this
 *                               `codex exec` refuses to run ("not inside a trusted
 *                               directory")
 *   - `-o <file>`             — write only the assistant's final message to a file,
 *                               which we read back as the result (cleaner than the
 *                               formatted stdout transcript)
 *   - `--dangerously-bypass-approvals-and-sandbox`
 *                             — auto-approve every action (incl. MCP tool calls such
 *                               as the runner-hosted open_issue) and disable codex's
 *                               local sandbox. Under the default `approval: never` +
 *                               `sandbox: read-only`, codex auto-CANCELS tool calls
 *                               it would otherwise need approval for, so the
 *                               capability tools never fire. This is codex's
 *                               equivalent of the Claude Code driver's
 *                               `bypassPermissions` and is justified the same way:
 *                               this engine only runs inside a throwaway ephemeral
 *                               container, so the container — not codex's sandbox —
 *                               is the safety boundary.
 *   - `-`                     — read the prompt from stdin
 * The API key rides on `CODEX_API_KEY` (codex exec's dedicated, preferred key,
 * which also avoids reading `~/.codex/auth.json`); `OPENAI_API_KEY` is set too for
 * compatibility (codex deprioritizes it but still accepts it).
 *
 * Like the Claude Code driver this only runs inside a throwaway ephemeral
 * container (enforced by CodexEngine.supports) — the container, not a human, is
 * the safety boundary. It is exercised only when the operator sets
 * RUNNER_ENABLE_CODEX=1; every test injects a fake driver, so no binary/network
 * is touched in CI.
 */
export async function* defaultCodexDriver(opts: CodexOptions): AsyncIterable<CodexMessage> {
  const controller = new AbortController()
  const timer =
    opts.maxDurationMs && opts.maxDurationMs > 0
      ? setTimeout(() => controller.abort(), opts.maxDurationMs)
      : undefined

  const outDir = await mkdtemp(path.join(tmpdir(), "jumpdrive-codex-out-"))
  const lastMessageFile = path.join(outDir, "last-message.txt")

  try {
    const child = spawn(
      "codex",
      [
        "exec",
        "-m",
        opts.model,
        "-C",
        opts.cwd,
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-o",
        lastMessageFile,
        "-",
      ],
      {
        cwd: opts.cwd,
        signal: controller.signal,
        env: {
          ...process.env,
          CODEX_HOME: opts.codexHome,
          // The capability stdio MCP server reads these from its env; set them on the
          // codex process env so the spawned server inherits them even if codex does
          // not forward the config.toml env table (belt-and-suspenders with that table).
          ...opts.capabilityEnv,
          ...(opts.apiKey ? { CODEX_API_KEY: opts.apiKey, OPENAI_API_KEY: opts.apiKey } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    child.stdin.end(opts.prompt)

    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (out += chunk))
    child.stderr.on("data", (chunk: string) => (err += chunk))

    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (c) => resolve(c ?? 0))
    })

    // On a FAILED run, surface a tail of codex's stderr as an assistant message so it
    // lands in the run logs for diagnosis — codex logs MCP-server startup + tool-call
    // activity there, which is otherwise invisible (the `-o` file holds only the final
    // assistant message). Gated to `code !== 0`: on the happy path this tail is the
    // full codex transcript (including the entire prompt), so emitting it every run is
    // pure log bloat + prompt duplication.
    if (code !== 0 && err.trim()) {
      const tail = err.length > 4000 ? `…${err.slice(-4000)}` : err
      yield { kind: "assistant", text: `codex stderr:\n${tail}` }
    }

    // Prefer codex's final-message file; fall back to the raw stdout/stderr transcript.
    const lastMessage = await readFile(lastMessageFile, "utf8").catch(() => "")
    const text = lastMessage.trim() || out.trim() || err.trim()
    yield { kind: "result", text, isError: code !== 0 }
  } finally {
    if (timer) clearTimeout(timer)
    await rm(outDir, { recursive: true, force: true })
  }
}
