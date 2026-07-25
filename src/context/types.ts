import type { WorkflowDefinition } from "../types.js"

/**
 * Pluggable context assembly.
 *
 * A run's context started life as a single pre-assembled string on the run
 * spec. That works when context is one static thing, and stops working the
 * moment it isn't: a live perception feed, a retrieval index, and a file
 * excerpt are three sources with different latencies and different failure
 * modes, and none of them should have to be flattened by the caller before the
 * kernel will accept them.
 *
 * So the string becomes a chain. Providers are asked in parallel for fragments;
 * fragments are ordered and rendered into the prompt. A private real-time
 * source plugs in here without the kernel knowing anything about it.
 */

/** One piece of assembled context. */
export interface ContextFragment {
  /** Which provider produced it — rendered as the section heading. */
  source: string
  text: string
  /** Higher sorts first. Defaults to 0; ties keep provider order. */
  priority?: number
  /** Free-form detail for callers that post-process fragments. */
  meta?: Record<string, unknown>
}

/**
 * What a provider is told about the run. A narrow, read-only view — every field
 * is optional so an engine's own richer run spec structurally satisfies it
 * without the kernel having to convert between them.
 */
export interface ContextSpec {
  runId?: string
  workspaceId?: string
  workflowPath?: string
  /** The prepared working tree, for providers that read from disk. */
  workdir?: string
  inputs?: Record<string, unknown>
  workflow?: WorkflowDefinition
}

/**
 * A source of run context. Implementations should be cheap to construct and do
 * their work in `assemble`, which may be called concurrently with other
 * providers.
 */
export interface ContextProvider {
  readonly name: string
  assemble(spec: ContextSpec): Promise<ContextFragment[]>
}

/**
 * Ask every provider for fragments and return them in render order.
 *
 * Providers run **in parallel** — they are independent sources and a slow one
 * shouldn't serialise behind the others. A provider that throws is logged and
 * skipped rather than failing the run: context is additive by nature, and
 * losing one optional source is not a reason to abandon work that the remaining
 * sources can still support. (This is the one place the kernel degrades instead
 * of failing loud, and it is deliberate — a *missing model* is a broken run,
 * a missing context fragment is a thinner prompt.)
 */
export async function assembleContext(
  providers: ContextProvider[],
  spec: ContextSpec,
  log: (line: string) => void = () => {},
): Promise<ContextFragment[]> {
  const settled = await Promise.allSettled(providers.map((p) => p.assemble(spec)))

  const fragments: ContextFragment[] = []
  settled.forEach((outcome, index) => {
    const provider = providers[index]
    if (!provider) return
    if (outcome.status === "fulfilled") {
      fragments.push(...outcome.value)
      return
    }
    const reason: unknown = outcome.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    log(`context provider ${provider.name} failed: ${message}`)
  })

  // Stable sort by descending priority: providers that declare nothing keep the
  // order they were registered in.
  return fragments
    .map((fragment, index) => ({ fragment, index }))
    .sort((a, b) => (b.fragment.priority ?? 0) - (a.fragment.priority ?? 0) || a.index - b.index)
    .map(({ fragment }) => fragment)
}

/**
 * Render fragments into the prompt text an engine embeds. Each fragment becomes
 * a titled section so the model can tell sources apart; an empty list renders
 * as an empty string, which keeps a provider-less run byte-identical to one
 * that never had providers.
 */
export function renderContext(fragments: ContextFragment[]): string {
  return fragments.map((f) => `### ${f.source}\n${f.text}`).join("\n\n")
}
