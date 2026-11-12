/**
 * Internal: stop a child process that leads its own process group (spawned
 * with `detached: true`). Not exported from `index.ts`.
 */
import type { ChildProcess } from "node:child_process"

/** How long a stopped harness gets to exit on SIGTERM before SIGKILL. */
export const DEFAULT_STOP_GRACE_MS = 5_000

/**
 * How long to wait, after SIGKILL, for the group to disappear. Death and
 * reaping normally take milliseconds; the bound only matters where nothing
 * reaps orphans (a container whose PID 1 is not an init), so a dead
 * descendant lingers as a zombie and the group never empties.
 */
export const KILL_SETTLE_MS = 1_000

const SETTLE_POLL_MS = 10

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

/** True while any process (zombies included) still belongs to group `pgid`. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    // ESRCH: the group is empty. EPERM: the id now names someone else's group.
    return false
  }
}

/**
 * SIGTERM the group, wait up to `graceMs` for the leader to exit, then SIGKILL
 * whatever remains of the group — unconditionally, so a descendant that
 * ignored SIGTERM (or outlived its parent) cannot keep running after this
 * resolves. SIGKILL is delivered asynchronously, so this then waits (up to
 * `KILL_SETTLE_MS`) until no process is left in the group: when it resolves,
 * nothing in the group is still executing.
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
  const pgid = child.pid
  if (pgid === undefined) return
  const settleBy = Date.now() + KILL_SETTLE_MS
  while (groupExists(pgid) && Date.now() < settleBy) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS))
  }
}
