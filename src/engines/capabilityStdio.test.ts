import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readEmissions } from "./capabilityEmissions.js"
import { buildCapabilityStdioServer, serveCapability } from "./capabilityStdio.js"

/** Connect a client to a freshly built capability server over a linked in-memory pair. */
async function connectClient(config: {
  workspaceId: string
  workdir: string
  emissionsFile: string
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildCapabilityStdioServer(config)
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

describe("capability stdio server", () => {
  let workdir: string
  let emitDir: string
  let emissionsFile: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "capstdio-wd-"))
    emitDir = await mkdtemp(path.join(tmpdir(), "capstdio-emit-"))
    emissionsFile = path.join(emitDir, "emissions.json")
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    await rm(emitDir, { recursive: true, force: true })
  })

  it("exposes exactly the three capability tools over MCP", async () => {
    const { client, close } = await connectClient({
      workspaceId: "ws-self",
      workdir,
      emissionsFile,
    })
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      ["open_issue", "promote_knowledge", "write_file"].sort(),
    )
    await close()
  })

  it("persists open_issue + promote_knowledge to the emissions file (read back by the engine)", async () => {
    const { client, close } = await connectClient({
      workspaceId: "ws-self",
      workdir,
      emissionsFile,
    })
    await client.callTool({ name: "open_issue", arguments: { title: "look", dedupe_key: "k" } })
    await client.callTool({ name: "promote_knowledge", arguments: { content: "learned X" } })

    expect(await readEmissions(emissionsFile)).toEqual({
      issues: [{ title: "look", dedupe_key: "k" }],
      knowledge: [{ content: "learned X" }],
    })
    await close()
  })

  it("write_file lands in the sandbox (not the emissions file)", async () => {
    const { client, close } = await connectClient({
      workspaceId: "ws-self",
      workdir,
      emissionsFile,
    })
    await client.callTool({ name: "write_file", arguments: { path: "out.md", content: "# hi" } })
    expect(await readFile(path.join(workdir, "out.md"), "utf8")).toBe("# hi")
    await close()
  })

  it("does not advertise workspace_id — scope is not selectable over MCP", async () => {
    const { client, close } = await connectClient({
      workspaceId: "ws-self",
      workdir,
      emissionsFile,
    })
    const listed = await client.listTools()
    for (const t of listed.tools) {
      const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>
      expect(Object.keys(props)).not.toContain("workspace_id")
      expect(Object.keys(props)).not.toContain("workspaceId")
    }
    // A stray workspace_id is stripped by the tool schema, so an emit can only ever
    // land in the bound workspace (the handler-level denial is covered in
    // capability.test.ts). Prove the redirect attempt is neutralized, not honored.
    await client.callTool({
      name: "open_issue",
      arguments: { title: "confined", workspace_id: "ws-other" },
    })
    expect(await readEmissions(emissionsFile)).toEqual({
      issues: [{ title: "confined" }],
      knowledge: [],
    })
    await close()
  })

  it("serveCapability connects a server over the given transport", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = await serveCapability(
      { workspaceId: "w", workdir, emissionsFile },
      serverTransport,
    )
    expect(server).toBeDefined()
    await server.close()
  })
})
