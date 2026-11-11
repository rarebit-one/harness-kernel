import type { Tool } from "./registry.js"

/**
 * A run's opt-in to executing one step's tool calls in parallel.
 *
 * Absent, the loop runs every call of a step in series, in the order the model
 * issued them, which is how it has always run. Present, calls the predicate
 * vouches for run in parallel, up to `maxConcurrent` at once.
 *
 * The predicate is the caller's, deliberately. `ToolMetadata.concurrencySafe`
 * is the shared word a tool uses to say it is safe (pass `isConcurrencySafe`
 * to honour it), but deciding to act on that claim is policy, and the loop
 * reads no metadata besides `dispatch`. An application with its own rule (by
 * name, by connector, by a field of its own) passes that instead.
 *
 * The ordering rule keeps the model's order wherever it can matter. A step's
 * calls are split, in order, into segments: each run of consecutive safe calls
 * is one segment and runs in parallel; every other call is a segment of its
 * own. A segment starts only when the one before it has settled. So a call
 * nobody vouched for still sees every earlier call finished and no later call
 * started, exactly as in series; only calls that each declared they do not
 * care are reordered among themselves. Results go back to the model in the
 * order it issued the calls, whatever order they finished in.
 */
export interface ToolConcurrency {
  /** The most calls in flight at once. A positive integer; 1 is the same as series. */
  maxConcurrent: number
  /** Whether a call to this tool may run beside others of the same step. */
  concurrencySafe: (tool: Tool) => boolean
}

/** Refuse a cap the loop cannot honour, before the run spends anything. */
export function assertToolConcurrency(concurrency: ToolConcurrency | undefined): void {
  if (concurrency === undefined) return
  const max = concurrency.maxConcurrent
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `toolConcurrency.maxConcurrent must be a positive integer, got ${String(max)}; ` +
        "omit toolConcurrency to run tool calls in series",
    )
  }
}

/**
 * Run `items` through `run` under the segment rule in {@link ToolConcurrency},
 * returning the results in item order. With no `safe` predicate every item is
 * its own segment, which is plain series.
 *
 * Within a segment, items start in order: the lowest index not yet started is
 * always the next to start, so anything `run` does before its first `await`
 * (emitting a `tool.called`, say) happens in item order too.
 */
export async function runInSegments<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  options?: { maxConcurrent: number; safe: (item: T) => boolean },
): Promise<R[]> {
  const max = options?.maxConcurrent ?? 1
  const safe = items.map((item) => options?.safe(item) ?? false)
  const out: R[] = []
  for (let start = 0; start < items.length;) {
    let end = start + 1
    if (safe[start]) while (end < items.length && safe[end]) end += 1
    out.push(...(await pool(items.slice(start, end), max, run)))
    start = end
  }
  return out
}

/** At most `max` of `items` in flight at once, started in order; results in order. */
async function pool<T, R>(items: T[], max: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()))
  return out
}
