import type { ModelRef } from "../models/registry.js"
import type { InvocationMode } from "../tools/metadata.js"

/**
 * Route resolution: "which model, prompt and tools should capability X use?"
 *
 * This sits **one layer above** the model registry. A resolver picks the whole
 * bundle for a named capability; the {@link ModelRef} it returns is then bound
 * to a concrete implementation by `ModelRegistry.resolve`. The two are not the
 * same question and must not be conflated:
 *
 *   resolver:  "summarise-thread"      → { model: chat:anthropic, prompt, tools }
 *   registry:  { kind: "chat", id: "anthropic" } → the ModelInvocation
 *
 * The kernel ships exactly one resolver — {@link StaticRouteResolver}, backed by
 * plain code or config, usable with zero infrastructure. A database-backed
 * resolver is an **app-layer adapter behind this interface**, never a kernel
 * concern: the kernel has no database, no schema and no control plane, and the
 * moment a field here exists only to serve one product's tables, this seam has
 * drifted across the line.
 */

/** A capability as declared by the application: the bundle, before resolution. */
export interface CapabilityDefinition {
  /** The name callers route by. */
  name: string
  /** Which model kind + id serves it. */
  model: ModelRef
  /** System prompt for the capability. */
  prompt?: string
  /** Tool names this capability may use; absent means "no restriction". */
  tools?: string[]
  /** Budgets an engine or loop should honour. */
  limits?: RouteLimits
  /** Free-form application detail carried through resolution untouched. */
  meta?: Record<string, unknown>
}

export interface RouteLimits {
  maxSteps?: number
  maxDurationMs?: number
}

/** What a resolver returns: a fully-determined route for one capability. */
export interface ResolvedRoute {
  capability: string
  model: ModelRef
  prompt: string
  tools: string[]
  limits: RouteLimits
  meta?: Record<string, unknown>
}

/**
 * The little a resolver is told about the call site. Deliberately thin — the
 * moment this grows product-shaped fields, resolution has stopped being generic.
 */
export interface RouteContext {
  /** How the turn was invoked; a resolver may route differently per mode. */
  mode?: InvocationMode
  correlationId?: string
}

/** Thrown when a capability name has no route. */
export class UnknownCapabilityError extends Error {
  readonly capability: string

  constructor(capability: string, known: string[]) {
    const alternatives = known.length > 0 ? known.join(", ") : "(none defined)"
    super(`no route defined for capability "${capability}" — defined: ${alternatives}`)
    this.name = "UnknownCapabilityError"
    this.capability = capability
  }
}

/**
 * Resolves a capability name to a route. Implementations must **fail loud** on
 * an unknown capability rather than returning a default — a silently-defaulted
 * route sends traffic to the wrong model with no signal.
 */
export interface RouteResolver {
  readonly name: string
  resolve(capability: string, ctx?: RouteContext): Promise<ResolvedRoute>
}
