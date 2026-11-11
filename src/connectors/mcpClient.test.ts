import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { connectMcp, connectWithTransport, MCP_CLIENT_NAME } from "./mcpClient.js"
import { NativeEngine } from "../engines/native.js"
import type { Loop } from "../loop.js"
import type { RunSpec } from "../engines/types.js"
import type { ConnectorConfig } from "../types.js"

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

/**
 * A stateless Streamable HTTP MCP server on loopback. Its one tool, `whoami`,
 * answers with the Authorization header its request carried; `accept` decides
 * which headers get a 401 before the MCP layer sees them.
 */
async function authServer(accept: (authorization: string | undefined) => boolean = () => true) {
  const authorizations: string[] = []
  const clients: string[] = []
  const http = createServer((req, res) => {
    const authorization = req.headers.authorization
    authorizations.push(authorization ?? "")
    if (!accept(authorization)) {
      res.writeHead(401).end()
      return
    }
    const server = new McpServer({ name: "test-server", version: "0.0.1" })
    server.registerTool("whoami", { description: "echo the request's credential" }, (extra) => ({
      content: [{ type: "text" as const, text: String(extra.requestInfo?.headers.authorization) }],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on("close", () => {
      // Stateless: only the instance that answered `initialize` saw the client's identity.
      const info = server.server.getClientVersion()
      if (info) clients.push(`${info.name}@${info.version}`)
      void transport.close()
      void server.close()
    })
    void server.connect(transport).then(() => transport.handleRequest(req, res))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    authorizations,
    clients,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

type Servers = Awaited<ReturnType<typeof authServer>>
const text = (result: unknown): string | undefined =>
  (result as { content: Array<{ text?: string }> }).content[0]?.text

function httpConnector(endpoint: string, auth: ConnectorConfig["auth"]): ConnectorConfig {
  return { name: "crm", kind: "mcp", transport: "streamable_http", endpoint, auth }
}

describe("connectMcp auth", () => {
  let server: Servers | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it("sends a static bearer unchanged on every request, and reports it", async () => {
    server = await authServer()
    const reported: string[] = []
    const conn = await connectMcp(
      httpConnector(server.endpoint, { type: "bearer", token: "static-token-123" }),
      { onSecret: (v) => reported.push(v) },
    )

    expect(text(await conn.callTool("whoami"))).toBe("Bearer static-token-123")
    await conn.close()
    expect(new Set(server.authorizations)).toEqual(new Set(["Bearer static-token-123"]))
    expect(reported).toEqual(["static-token-123"])
  })

  it("asks an auth.headers function per request, so a rotation mid-run reaches the next call", async () => {
    server = await authServer()
    let current = "Bearer first-token-1"
    const reported = new Set<string>()
    const conn = await connectMcp(
      httpConnector(server.endpoint, {
        type: "bearer",
        headers: async () => ({ Authorization: current }),
      }),
      { onSecret: (v) => reported.add(v) },
    )

    expect(text(await conn.callTool("whoami"))).toBe("Bearer first-token-1")
    current = "Bearer second-token-2"
    expect(text(await conn.callTool("whoami"))).toBe("Bearer second-token-2")
    await conn.close()

    expect(reported).toEqual(
      new Set(["Bearer first-token-1", "first-token-1", "Bearer second-token-2", "second-token-2"]),
    )
  })

  it("refreshes once on a 401 and carries on with the fresh credential", async () => {
    server = await authServer((authorization) => authorization !== "Bearer expired-token")
    const conn = await connectMcp(
      httpConnector(server.endpoint, {
        type: "bearer",
        headers: ({ refresh }) => ({
          Authorization: refresh ? "Bearer renewed-token" : "Bearer expired-token",
        }),
      }),
    )

    expect(text(await conn.callTool("whoami"))).toBe("Bearer renewed-token")
    await conn.close()
  })

  it("fails the connection loudly when the auth function throws", async () => {
    server = await authServer()
    const config = httpConnector(server.endpoint, {
      type: "bearer",
      headers: () => {
        throw new Error("credential store unreachable: tok_live_should_not_leak")
      },
    })

    const err = await connectMcp(config).catch((e: unknown) => e)
    expect((err as Error).message).toBe("connector crm: auth headers function failed")
    expect(server.authorizations).toEqual([])
  })

  it("refuses a config that sets both a token and a headers function", async () => {
    await expect(
      connectMcp(
        httpConnector("http://127.0.0.1:1/mcp", {
          type: "bearer",
          token: "static-token-123",
          headers: () => ({}),
        }),
      ),
    ).rejects.toThrow("connector crm: set auth.token or auth.headers, not both")
  })

  it("refuses an auth.headers function on a stdio connector", async () => {
    await expect(
      connectMcp({
        name: "local",
        kind: "mcp",
        transport: "stdio",
        command: "true",
        auth: { type: "bearer", headers: () => ({}) },
      }),
    ).rejects.toThrow("stdio transport takes no auth.headers")
  })

  it("announces the default client identity unless clientInfo names one", async () => {
    server = await authServer()
    const plain = await connectMcp(httpConnector(server.endpoint, { type: "none" }))
    await plain.close()
    const named = await connectMcp({
      ...httpConnector(server.endpoint, { type: "none" }),
      clientInfo: { name: "acme-agent", version: "2.3.4" },
    })
    await named.close()
    const nameOnly = await connectMcp({
      ...httpConnector(server.endpoint, { type: "none" }),
      clientInfo: { name: "acme-agent" },
    })
    await nameOnly.close()

    expect(server.clients).toEqual([
      `${MCP_CLIENT_NAME}/crm@0.1.0`,
      "acme-agent@2.3.4",
      "acme-agent@0.1.0",
    ])
  })
})

describe("NativeEngine connector credential masking", () => {
  let server: Servers | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** A loop that calls the connector's `whoami` twice, rotating in between. */
  function whoamiTwice(rotate: () => void): { loop: Loop; seen: string[] } {
    const seen: string[] = []
    const loop: Loop = {
      name: "calls-whoami",
      run: async (req, ctx) => {
        const tool = req.tools.find((t) => t.spec.name === "crm__whoami")!
        const call = { signal: ctx.signal ?? new AbortController().signal, callId: "c" }
        seen.push(await tool.execute({}, call))
        rotate()
        seen.push(await tool.execute({}, call))
        return { text: "", steps: 1, outcome: "completed" }
      },
    }
    return { loop, seen }
  }

  async function run(loop: Loop, connector: ConnectorConfig): Promise<void> {
    const workdir = await mkdtemp(path.join(tmpdir(), "connector-mask-"))
    const spec: RunSpec = {
      runId: "r",
      workspaceId: "w",
      workflowPath: "wf.yml",
      workflow: { name: "Demo", prompt: "Do the thing." },
      inputs: {},
      context: "",
      workdir,
      permissions: { tools: [] },
      secrets: {},
      connectors: [connector],
      provider: { preferred: "mock" },
    }
    await new NativeEngine({ loop }).run(spec, { log: () => {} })
  }

  it("masks a token that rotates mid-run in what the connector's tool returns", async () => {
    server = await authServer()
    let n = 1
    const { loop, seen } = whoamiTwice(() => n++)
    await run(
      loop,
      httpConnector(server.endpoint, {
        type: "bearer",
        headers: () => ({ Authorization: `Bearer rotating-token-${n}` }),
      }),
    )

    expect(seen).toHaveLength(2)
    for (const out of seen) {
      expect(text(JSON.parse(out))).toBe("[secret]")
      expect(out).not.toContain("rotating-token")
    }
    // Both tokens really were sent.
    expect(server.authorizations).toContain("Bearer rotating-token-1")
    expect(server.authorizations).toContain("Bearer rotating-token-2")
  })

  it("masks a static bearer token the same way", async () => {
    server = await authServer()
    const { loop, seen } = whoamiTwice(() => {})
    await run(loop, httpConnector(server.endpoint, { type: "bearer", token: "static-token-456" }))

    expect(text(JSON.parse(seen[0]!))).toBe("Bearer [secret]")
  })
})
