import { describe, it, expect, beforeAll } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { primitiveTools, emissionTools, connectorTools } from "./registry.js"
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

describe("emissionTools", () => {
  it("exposes exactly the domain-emission tools", () => {
    expect(emissionTools().map((t) => t.spec.name)).toEqual(["promote_knowledge", "record_issue"])
  })

  it("records knowledge into the sink via promote_knowledge (and skips blank content)", async () => {
    const sink: { content: string; title?: string; kind?: string }[] = []
    const promote = emissionTools({ knowledge: sink }).find(
      (t) => t.spec.name === "promote_knowledge",
    )!

    expect(
      JSON.parse(await promote.execute({ content: "We prefer Queenstown.", title: "Prefs" })),
    ).toEqual({ ok: true })
    expect(sink).toEqual([{ content: "We prefer Queenstown.", title: "Prefs" }])

    expect((JSON.parse(await promote.execute({ content: "" })) as { ok: boolean }).ok).toBe(false)
    expect(sink).toHaveLength(1) // blank content not recorded
  })

  it("records issues into the sink via record_issue (and skips blank title)", async () => {
    const sink: { title: string; body?: string; dedupe_key?: string; labels?: string[] }[] = []
    const record = emissionTools({ issues: sink }).find((t) => t.spec.name === "record_issue")!

    expect(
      JSON.parse(
        await record.execute({
          title: "Renewal scan: 3 due",
          body: "table…",
          dedupe_key: "renewal-scan",
          labels: ["renewals"],
        }),
      ),
    ).toEqual({ ok: true })
    expect(sink).toEqual([
      {
        title: "Renewal scan: 3 due",
        body: "table…",
        dedupe_key: "renewal-scan",
        labels: ["renewals"],
      },
    ])

    expect((JSON.parse(await record.execute({ title: "" })) as { ok: boolean }).ok).toBe(false)
    expect(sink).toHaveLength(1) // blank title not recorded
  })

  it("tolerates an absent sink (the tool still reports ok)", async () => {
    const promote = emissionTools().find((t) => t.spec.name === "promote_knowledge")!
    expect(JSON.parse(await promote.execute({ content: "no sink here" }))).toEqual({ ok: true })
  })

  it("filters by the permissions allowlist, like the primitives", () => {
    const names = emissionTools({}, ["record_issue"]).map((t) => t.spec.name)
    expect(names).toEqual(["record_issue"])
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
