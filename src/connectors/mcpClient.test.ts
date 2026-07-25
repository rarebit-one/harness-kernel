import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { connectWithTransport } from "./mcpClient.js"

describe("mcpClient", () => {
  it("lists and calls tools over an in-memory transport", async () => {
    const server = new McpServer({ name: "test-server", version: "0.0.1" })
    server.registerTool(
      "echo",
      { description: "echo the input back", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const conn = await connectWithTransport("test", clientTransport)

    const tools = (await conn.listTools()) as { tools: Array<{ name: string }> }
    expect(tools.tools.map((t) => t.name)).toContain("echo")

    const result = (await conn.callTool("echo", { text: "hello" })) as {
      content: Array<{ type: string; text?: string }>
    }
    expect(result.content[0]?.text).toBe("hello")

    await conn.close()
  })
})
