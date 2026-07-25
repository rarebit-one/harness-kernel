import { NativeEngine } from "./native.js"
import { ClaudeCodeEngine } from "./claudeCode.js"
import { CodexEngine } from "./codex.js"
import type { AgentEngine } from "./types.js"

export type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"

const ENGINES: Record<string, () => AgentEngine> = {
  native: () => new NativeEngine(),
  "claude-code": () => new ClaudeCodeEngine(),
  codex: () => new CodexEngine(),
}

/**
 * Resolve the agent harness for a run from the workflow's `provider.engine`.
 * Defaults to the native loop; an unknown name also falls back to native (the
 * safe default), so a typo can't silently route to nothing. Capability gating
 * (isolation, enablement) is the engine's own `supports()` responsibility.
 */
export function selectEngine(name?: string | null): AgentEngine {
  const factory = name ? ENGINES[name] : undefined
  return (factory ?? (() => new NativeEngine()))()
}
