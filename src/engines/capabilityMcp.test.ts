import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { CapabilityTool } from "./capability.js"
import { CAPABILITY_SERVER_NAME, capabilitySdkServer, capabilityToolIds } from "./capabilityMcp.js"

// The MCP adapter is a transport: it takes whatever capability set it is handed.
// These fakes stand in for an application's surface precisely because the kernel
// no longer defines one.
const fake = (name: string): CapabilityTool => ({
  name,
  description: `the ${name} capability`,
  schema: { value: z.string() },
  handler: () => Promise.resolve({ ok: true }),
})

describe("capabilityMcp", () => {
  it("namespaces tool ids under the workspace server, whatever the surface", () => {
    expect(capabilityToolIds([fake("alpha"), fake("beta")])).toEqual([
      "mcp__workspace__alpha",
      "mcp__workspace__beta",
    ])
    expect(CAPABILITY_SERVER_NAME).toBe("workspace")
  })

  it("namespaces an empty surface to an empty list rather than failing", () => {
    expect(capabilityToolIds([])).toEqual([])
  })

  it("builds an in-process SDK server carrying the capabilities it was given", async () => {
    const server = await capabilitySdkServer([fake("alpha")])
    expect(server).toBeDefined()
    expect(server.name).toBe(CAPABILITY_SERVER_NAME)
  })
})
