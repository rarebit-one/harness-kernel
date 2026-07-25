import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { CapabilityTool } from "./capability.js"
import {
  buildCapabilityStdioServer,
  capabilityStdioConfigFromEnv,
  serveCapability,
  type CapabilityStdioOptions,
} from "./capabilityStdio.js"

// This module is the out-of-process transport, not a capability set: it serves
// whatever it is handed and fires `afterCall` so the spawning process can get
// state back across the process boundary. What that state *means* belongs to the
// application, so the fakes here are deliberately domain-free.

const echo = (name: string, onCall?: () => void): CapabilityTool => ({
  name,
  description: `the ${name} capability`,
  schema: { value: z.string().optional() },
  handler: (input) => {
    onCall?.()
    // "fail" is schema-valid but semantically refused, so the handler actually
    // runs — a schema-invalid input would be rejected upstream and never reach it.
    return Promise.resolve(input.value === "fail" ? { ok: false, error: "refused" } : { ok: true })
  },
})

async function connectClient(
  options: CapabilityStdioOptions,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildCapabilityStdioServer(options)
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("capability stdio server", () => {
  it("advertises exactly the tools it was given", async () => {
    const { client, close } = await connectClient({ tools: [echo("alpha"), echo("beta")] })
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"])
    await close()
  })

  it("an empty surface yields a server that does not even advertise tools", async () => {
    // The SDK only registers the tools/* methods once something is registered,
    // so an empty surface is not a quiet no-op server — it cannot list tools at
    // all. That is why selectEngine refuses codex without a capability script:
    // the failure would otherwise surface here, far from its cause.
    const { client, close } = await connectClient({ tools: [] })
    await expect(client.listTools()).rejects.toThrow(/Method not found/i)
    await close()
  })

  it("routes a call to the matching handler and returns its result", async () => {
    const { client, close } = await connectClient({ tools: [echo("alpha")] })
    const result = await client.callTool({ name: "alpha", arguments: { value: "x" } })
    expect(JSON.stringify(result.content)).toContain('{\\"ok\\":true}')
    await close()
  })

  it("fires afterCall after every call — the seam for crossing the process boundary", async () => {
    const afterCall = vi.fn(() => Promise.resolve())
    const { client, close } = await connectClient({ tools: [echo("alpha")], afterCall })

    await client.callTool({ name: "alpha", arguments: { value: "x" } })
    await client.callTool({ name: "alpha", arguments: { value: "y" } })

    expect(afterCall).toHaveBeenCalledTimes(2)
    await close()
  })

  it("fires afterCall even when the handler reports failure", async () => {
    const afterCall = vi.fn(() => Promise.resolve())
    const { client, close } = await connectClient({ tools: [echo("alpha")], afterCall })

    await client.callTool({ name: "alpha", arguments: { value: "fail" } })

    expect(afterCall).toHaveBeenCalledTimes(1)
    await close()
  })

  it("serveCapability connects a server over the given transport", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = await serveCapability({ tools: [echo("alpha")] }, serverTransport)
    expect(server).toBeDefined()
    await server.close()
  })
})

describe("capabilityStdioConfigFromEnv", () => {
  it("reads the spawn contract from the environment", () => {
    vi.stubEnv("HARNESS_WORKSPACE_ID", "ws-1")
    vi.stubEnv("HARNESS_WORKDIR", "/tmp/wd")
    vi.stubEnv("HARNESS_EMISSIONS_FILE", "/tmp/emit.json")

    expect(capabilityStdioConfigFromEnv()).toEqual({
      workspaceId: "ws-1",
      workdir: "/tmp/wd",
      emissionsFile: "/tmp/emit.json",
    })
  })

  it("fails loud when the contract is incomplete", () => {
    vi.stubEnv("HARNESS_WORKSPACE_ID", "ws-1")
    vi.stubEnv("HARNESS_WORKDIR", "")
    vi.stubEnv("HARNESS_EMISSIONS_FILE", "/tmp/emit.json")

    expect(() => capabilityStdioConfigFromEnv()).toThrow(/HARNESS_WORKSPACE_ID/)
  })
})
