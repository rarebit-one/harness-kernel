import {
  UnknownCapabilityError,
  type CapabilityDefinition,
  type ResolvedRoute,
  type RouteContext,
  type RouteResolver,
} from "./types.js"

/**
 * The kernel's built-in resolver: capabilities as code.
 *
 * It takes a list of {@link CapabilityDefinition}s — from a literal, a JSON
 * file, environment config, anything the application already has — and resolves
 * names against them in memory. No database, no migration, no service to stand
 * up. That matters beyond convenience: it means the whole seam is exercisable
 * in a unit test, and an application that never wants dynamic routing never
 * needs any infrastructure at all.
 *
 * An application that *does* want dynamic routing writes its own
 * {@link RouteResolver} against the same interface. That adapter — with its
 * tables, its prompt versioning, its per-tenant overrides — lives in the app
 * layer. It does not live here.
 */
export class StaticRouteResolver implements RouteResolver {
  readonly name = "static"

  private readonly definitions = new Map<string, CapabilityDefinition>()

  constructor(definitions: CapabilityDefinition[] = []) {
    for (const definition of definitions) this.define(definition)
  }

  /**
   * Add or replace a capability. Unlike the model registry, redefinition is
   * allowed: a resolver is configuration, and layering a config file over a
   * built-in default is a normal thing to want.
   */
  define(definition: CapabilityDefinition): this {
    this.definitions.set(definition.name, definition)
    return this
  }

  has(capability: string): boolean {
    return this.definitions.has(capability)
  }

  /** Every defined capability name. */
  capabilities(): string[] {
    return [...this.definitions.keys()]
  }

  /**
   * Resolve a name to its route, filling defaults for the optional parts so
   * callers get a fully-determined {@link ResolvedRoute}. Throws
   * {@link UnknownCapabilityError} when the name isn't defined.
   *
   * `ctx` is accepted for interface parity and ignored here — static routing is
   * by definition context-free. A resolver that varies by invocation mode or
   * tenant is exactly the app-layer adapter this interface exists to admit.
   */
  resolve(capability: string, _ctx?: RouteContext): Promise<ResolvedRoute> {
    const definition = this.definitions.get(capability)
    if (!definition) {
      // Rejected, not thrown: the interface promises a Promise, and a caller
      // that attached `.catch()` instead of awaiting would otherwise be hit by
      // a synchronous throw it never had a chance to handle.
      return Promise.reject(new UnknownCapabilityError(capability, this.capabilities()))
    }

    return Promise.resolve({
      capability: definition.name,
      model: definition.model,
      prompt: definition.prompt ?? "",
      tools: definition.tools ?? [],
      limits: definition.limits ?? {},
      ...(definition.meta ? { meta: definition.meta } : {}),
    })
  }
}
