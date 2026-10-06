/**
 * Internal: stop a child process that leads its own process group (spawned
 * with `detached: true`). Not exported from `index.ts`.
 */
import type { ChildProcess } from "node:child_process"

/** How long a stopped harness gets to exit on SIGTERM before SIGKILL. */
export const DEFAULT_STOP_GRACE_MS = 5_000

/** Signal the whole group; fall back to the leader if the group is gone. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, sig)
  } catch {
    try {
      child.kill(sig)
    } catch {
      // already gone
    }
  }
}

/**
 * SIGTERM the group, wait up to `graceMs` for the leader to exit, then SIGKILL
 * whatever remains of the group — unconditionally, so a descendant that
 * ignored SIGTERM (or outlived its parent) cannot keep running after this
 * resolves. SIGKILL cannot be ignored, so when this resolves nothing in the
 * group is still executing.
 */
export async function terminateProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  signalGroup(child, "SIGTERM")
  if (!exited()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  signalGroup(child, "SIGKILL")
}
