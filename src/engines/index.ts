import { NativeEngine, type DomainToolFactory } from "./native.js"
import { ClaudeCodeEngine, type CapabilityToolFactory } from "./claudeCode.js"
import { CodexEngine } from "./codex.js"
import type { AgentEngine } from "./types.js"

export type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"

/**
 * The application-supplied seams an engine needs. The kernel defines no domain
 * tools and no application capabilities, so anything product-specific reaches
 * the engines through here rather than being baked in.
 */
export interface EngineSelection {
  /** Extra tools for the in-process loop, beyond the generic primitives. */
  domainTools?: DomainToolFactory
  /** The capability surface exposed to Claude Code over its in-process MCP server. */
  capabilityTools?: CapabilityToolFactory
  /**
   * Entrypoint script the codex engine spawns to serve its capability surface.
   * Required to select `codex` — a child process cannot be handed a closure, so
   * the application must own that script.
   */
  capabilityServerScript?: string
}

/**
 * Resolve the agent harness for a run from the workflow's `provider.engine`.
 * Defaults to the native loop; an unknown name also falls back to native (the
 * safe default), so a typo can't silently route to nothing. Capability gating
 * (isolation, enablement) is the engine's own `supports()` responsibility.
 *
 * Selecting `codex` without `capabilityServerScript` throws rather than
 * defaulting: the alternative is an external engine that comes up with an empty
 * capability surface, which looks like a working run that quietly emits nothing.
 */
export function selectEngine(name?: string | null, selection: EngineSelection = {}): AgentEngine {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeEngine(undefined, selection.capabilityTools)
    case "codex": {
      if (!selection.capabilityServerScript) {
        throw new Error(
          "the codex engine requires selection.capabilityServerScript — the capability surface is " +
            "injected, and an external process cannot be handed one implicitly",
        )
      }
      return new CodexEngine(undefined, selection.capabilityServerScript)
    }
    default:
      return new NativeEngine(selection.domainTools ? { domainTools: selection.domainTools } : {})
  }
}
