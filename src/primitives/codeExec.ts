import { spawn } from "node:child_process"

export interface RunCodeOptions {
  /** Working directory — normally the run sandbox. */
  cwd: string
  command: string
  args?: string[]
  /** Extra environment (e.g. secretsToEnv output). Merged over a minimal base. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  stdin?: string
  maxBuffer?: number
}

export interface RunCodeResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Run a command inside the sandbox. This is the general-purpose escape hatch the
 * agent uses to run the workspace's OWN repo scripts — or code it writes on the
 * fly — so domain logic lives in user code, never baked into the platform.
 * Secrets are passed via `env` (see secretsToEnv) and are never logged here.
 */
export function runCode(options: RunCodeOptions): Promise<RunCodeResult> {
  const {
    cwd,
    command,
    args = [],
    env,
    stdin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBuffer = DEFAULT_MAX_BUFFER,
  } = options

  return new Promise<RunCodeResult>((resolve, reject) => {
    // A minimal base env with the caller's env — including resolved secrets —
    // layered on top. We forward only non-secret runtime vars: PATH (so binaries
    // resolve) and HOME (so npm/tooling use a stable cache dir — `$HOME/.npm`
    // persists across runs on the warm pool, so a beat's `setup: [npm ci]` relinks
    // instead of re-downloading). The runner's other env (tokens, provider keys)
    // is deliberately NOT forwarded. `detached` puts the child in its own process
    // group so the timeout can kill the WHOLE tree (a repo script that spawns
    // subprocesses would otherwise orphan them).
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      detached: true,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const cap = (current: string, chunk: Buffer): string =>
      current.length >= maxBuffer ? current : (current + chunk.toString()).slice(0, maxBuffer)

    const killTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL") // negative pid = process group
      } catch {
        child.kill("SIGKILL")
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    child.stdout?.on("data", (c: Buffer) => {
      stdout = cap(stdout, c)
    })
    child.stderr?.on("data", (c: Buffer) => {
      stderr = cap(stderr, c)
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut })
    })

    if (stdin !== undefined) child.stdin?.write(stdin)
    child.stdin?.end()
  })
}
