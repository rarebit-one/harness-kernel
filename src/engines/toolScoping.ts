import type { Tool } from "../tools/registry.js"
import { selectTools } from "../tools/metadata.js"
import type { RunSpec } from "./types.js"

/**
 * The run's tool surface narrowed by `RunSpec.capability` / `RunSpec.mode`,
 * through the same projection a direct caller uses (`selectTools`). A spec
 * that sets neither is unscoped and keeps every tool, as before the fields
 * existed. Once either is set the projection fails closed: a tool scoped on a
 * dimension the spec leaves absent is hidden.
 *
 * This runs where the engine assembles the surface, never in the loop: the
 * loop acts on exactly one piece of tool metadata, `dispatch`.
 */
export function scopeRunTools(tools: Tool[], spec: Pick<RunSpec, "capability" | "mode">): Tool[] {
  if (spec.capability === undefined && spec.mode === undefined) return tools
  return selectTools(tools, { capability: spec.capability, mode: spec.mode })
}

/**
 * The `supports()` refusal an out-of-process engine gives a run that sets
 * `capability` or `mode`, or `undefined` when it sets neither. Such an engine
 * mounts the capability server and connectors whole, so it cannot hide a tool
 * scoped elsewhere: running anyway would quietly widen the surface the caller
 * asked for.
 */
export function refuseToolScoping(
  engine: string,
  spec: Pick<RunSpec, "capability" | "mode">,
): { ok: false; reason: string } | undefined {
  const set = (["capability", "mode"] as const).filter((field) => spec[field] !== undefined)
  if (set.length === 0) return undefined
  return {
    ok: false,
    reason:
      `${engine} engine cannot scope its tools by metadata ` +
      `(the run sets ${set.join(" and ")}); use the native engine or drop the field`,
  }
}
