import { describe, it, expect, beforeAll } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { primitiveTools, connectorTools } from "./registry.js"
import type { McpConnection } from "../connectors/mcpClient.js"

describe("primitiveTools", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ws-reg-"))
    await writeFile(path.join(dir, "f.txt"), "body")
  })

  it("exposes the general-purpose primitives", () => {
    const names = primitiveTools(dir, {}).map((t) => t.spec.name)
    expect(names).toEqual(["run_code", "read_file", "list_files", "http_fetch"])
  })

  it("carries no domain-emission tools (those are composed in separately)", () => {
    const names = primitiveTools(dir, {}).map((t) => t.spec.name)
    expect(names).not.toContain("promote_knowledge")
    expect(names).not.toContain("record_issue")
  })

  it("reads a file and runs code with injected secrets", async () => {
    const tools = primitiveTools(dir, { SECRET: "s3cr3t" })
    const read = tools.find((t) => t.spec.name === "read_file")!
    expect(await read.execute({ path: "f.txt" })).toBe("body")

    const run = tools.find((t) => t.spec.name === "run_code")!
    const out = JSON.parse(
      await run.execute({
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.SECRET || '')"],
      }),
    ) as { stdout: string }
    expect(out.stdout).toBe("s3cr3t")
  })

  it("runs a command line through a shell when no args are given (env expanded)", async () => {
    const run = primitiveTools(dir, { GREETING: "hi" }).find((t) => t.spec.name === "run_code")!
    // A single command string with a shell-ism ($VAR) — the case that used to
    // ENOENT under bare spawn. Now runs via /bin/sh -c.
    const out = JSON.parse(await run.execute({ command: 'printf %s "$GREETING"' })) as {
      stdout: string
      exitCode: number
    }
    expect(out.stdout).toBe("hi")
    expect(out.exitCode).toBe(0)
  })

  it("filters by the permissions allowlist", () => {
    const names = primitiveTools(dir, {}, ["read_file"]).map((t) => t.spec.name)
    expect(names).toEqual(["read_file"])
  })
})

describe("connectorTools", () => {
  it("namespaces and proxies MCP connector tools", async () => {
    const fakeConn: McpConnection = {
      listTools: async () => ({
        tools: [{ name: "search", description: "find things", inputSchema: { type: "object" } }],
      }),
      callTool: async (name, args) => ({
        content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      }),
      close: async () => {},
    }

    const { tools, close } = await connectorTools(
      [{ name: "linear", kind: "mcp", transport: "streamable_http", endpoint: "https://x" }],
      async () => fakeConn,
    )

    expect(tools.map((t) => t.spec.name)).toEqual(["linear__search"])
    expect(await tools[0]!.execute({ q: "hi" })).toContain("search")
    await close()
  })

  it("ignores non-mcp connectors", async () => {
    const { tools } = await connectorTools([
      { name: "x", kind: "http", transport: "streamable_http", endpoint: "https://x" },
    ])
    expect(tools).toEqual([])
  })

  it("closes already-opened connections when a later connect fails", async () => {
    const closed: string[] = []
    const good: McpConnection = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => {
        closed.push("good")
      },
    }
    let n = 0
    const connect = async (): Promise<McpConnection> => {
      n += 1
      if (n === 1) return good
      throw new Error("boom")
    }

    await expect(
      connectorTools(
        [
          { name: "a", kind: "mcp", transport: "streamable_http", endpoint: "https://a" },
          { name: "b", kind: "mcp", transport: "streamable_http", endpoint: "https://b" },
        ],
        connect,
      ),
    ).rejects.toThrow("boom")
    expect(closed).toEqual(["good"])
  })
})
