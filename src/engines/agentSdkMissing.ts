// Kept apart from the loader so the public declarations that re-export this
// error never reference the optional SDK's types.
export const AGENT_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk"

/** Thrown when the claude-code engine runs without its optional peer installed. */
export class AgentSdkMissingError extends Error {
  constructor(cause: unknown) {
    super(
      `the claude-code engine needs the optional peer dependency ${AGENT_SDK_SPECIFIER}, ` +
        "which is not installed; add it to the application's own dependencies",
      { cause },
    )
    this.name = "AgentSdkMissingError"
  }
}
