import { AGENT_SDK_SPECIFIER as SPECIFIER, AgentSdkMissingError } from "./agentSdkMissing.js"

type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk")

function isMissingSdk(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    error.message.includes(SPECIFIER)
  )
}

/**
 * Load the Agent SDK, which is an OPTIONAL peer: an application that never runs
 * the claude-code engine does not install it (or the vendor CLI binaries it
 * carries). Only the claude-code driver reaches this, and a missing package
 * fails loud with the fix rather than as a bare resolution error. `importer` is
 * injectable so the failure path is testable without uninstalling anything.
 */
export async function loadAgentSdk(
  importer: () => Promise<AgentSdk> = () => import("@anthropic-ai/claude-agent-sdk"),
): Promise<AgentSdk> {
  try {
    return await importer()
  } catch (error) {
    if (isMissingSdk(error)) throw new AgentSdkMissingError(error)
    throw error
  }
}
