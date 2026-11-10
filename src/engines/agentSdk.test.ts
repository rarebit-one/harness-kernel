import { describe, expect, it } from "vitest"
import { loadAgentSdk } from "./agentSdk.js"
import { AgentSdkMissingError } from "./agentSdkMissing.js"

type AgentSdk = Awaited<ReturnType<typeof loadAgentSdk>>

function resolutionError(specifier: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from /app/x.js`), {
    code: "ERR_MODULE_NOT_FOUND",
  })
}

describe("loadAgentSdk", () => {
  it("returns the module the importer resolves", async () => {
    const sdk = { query: () => undefined } as unknown as AgentSdk
    await expect(loadAgentSdk(() => Promise.resolve(sdk))).resolves.toBe(sdk)
  })

  it("names the missing optional peer when the SDK is not installed", async () => {
    const cause = resolutionError("@anthropic-ai/claude-agent-sdk")
    const failure = loadAgentSdk(() => Promise.reject(cause))
    await expect(failure).rejects.toBeInstanceOf(AgentSdkMissingError)
    await expect(failure).rejects.toThrow(
      /optional peer dependency @anthropic-ai\/claude-agent-sdk/,
    )
    await expect(failure).rejects.toHaveProperty("cause", cause)
  })

  it("leaves another package's resolution failure untouched", async () => {
    const cause = resolutionError("some-transitive-package")
    await expect(loadAgentSdk(() => Promise.reject(cause))).rejects.toBe(cause)
  })

  it("leaves an unrelated error untouched", async () => {
    const cause = new Error("boom")
    await expect(loadAgentSdk(() => Promise.reject(cause))).rejects.toBe(cause)
  })
})
