import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../types.js"
import {
  connectorServers,
  connectorToMcpServer,
  writeCodexConfig,
  writeMcpJson,
} from "./connectorMcp.js"

describe("connectorToMcpServer", () => {
  it("maps streamable_http with a bearer token to an http server + Authorization header", () => {
    const cfg: ConnectorConfig = {
      name: "slack",
      kind: "mcp",
      transport: "streamable_http",
      endpoint: "https://mcp.example.com/",
      auth: { type: "bearer", token: "t0k" },
    }
    expect(connectorToMcpServer(cfg)).toEqual({
      type: "http",
      url: "https://mcp.example.com/",
      headers: { Authorization: "Bearer t0k" },
    })
  })

  it("maps sse (no auth) to an sse server without headers", () => {
    const cfg: ConnectorConfig = {
      name: "events",
      kind: "mcp",
      transport: "sse",
      endpoint: "https://sse.example.com/",
      auth: { type: "none" },
    }
    expect(connectorToMcpServer(cfg)).toEqual({ type: "sse", url: "https://sse.example.com/" })
  })

  it("maps stdio with a bearer token to a stdio server carrying MCP_AUTH_TOKEN in env", () => {
    const cfg: ConnectorConfig = {
      name: "local",
      kind: "mcp",
      transport: "stdio",
      command: "my-mcp",
      args: ["--flag"],
      auth: { type: "bearer", token: "sekret" },
    }
    expect(connectorToMcpServer(cfg)).toEqual({
      type: "stdio",
      command: "my-mcp",
      args: ["--flag"],
      env: { MCP_AUTH_TOKEN: "sekret" },
    })
  })

  it("returns null for a plain http (non-mcp) connector", () => {
    const cfg: ConnectorConfig = {
      name: "webhook",
      kind: "http",
      transport: "streamable_http",
      endpoint: "https://x/",
    }
    expect(connectorToMcpServer(cfg)).toBeNull()
  })

  it("returns null for a malformed connector (missing endpoint / command)", () => {
    expect(
      connectorToMcpServer({ name: "a", kind: "mcp", transport: "streamable_http" }),
    ).toBeNull()
    expect(connectorToMcpServer({ name: "b", kind: "mcp", transport: "stdio" })).toBeNull()
  })
})

describe("connectorServers", () => {
  it("builds a name→config map and skips non-translatable connectors", () => {
    const connectors: ConnectorConfig[] = [
      { name: "slack", kind: "mcp", transport: "streamable_http", endpoint: "https://s/" },
      { name: "plain", kind: "http", transport: "streamable_http", endpoint: "https://p/" },
      { name: "local", kind: "mcp", transport: "stdio", command: "run" },
    ]
    expect(connectorServers(connectors)).toEqual({
      slack: { type: "http", url: "https://s/" },
      local: { type: "stdio", command: "run" },
    })
  })
})

describe("writeMcpJson", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "mcpjson-test-"))
  })
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })

  it("writes a .mcp.json with the mcpServers field", async () => {
    const servers = { slack: { type: "http" as const, url: "https://s/" } }
    await writeMcpJson(workdir, servers)
    const written = JSON.parse(await readFile(path.join(workdir, ".mcp.json"), "utf8")) as unknown
    expect(written).toEqual({ mcpServers: servers })
  })

  it("does not write a file when there are no servers", async () => {
    await writeMcpJson(workdir, {})
    await expect(readFile(path.join(workdir, ".mcp.json"), "utf8")).rejects.toThrow()
  })
})

describe("writeCodexConfig", () => {
  let codexHome: string
  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(tmpdir(), "codexcfg-test-"))
  })
  afterEach(async () => {
    if (codexHome) await rm(codexHome, { recursive: true, force: true })
  })

  it("writes config.toml with [mcp_servers.<name>] sections in codex's real TOML format", async () => {
    const written = await writeCodexConfig(codexHome, {
      slack: { type: "http", url: "https://s/", headers: { Authorization: "Bearer t0k" } },
      local: { type: "stdio", command: "run", args: ["--flag"], env: { MCP_AUTH_TOKEN: "sekret" } },
    })
    expect(written).toBe(path.join(codexHome, "config.toml"))
    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8")

    // HTTP server: url + inline bearer token in http_headers (why it must be transient).
    expect(toml).toContain('[mcp_servers."slack"]')
    expect(toml).toContain('url = "https://s/"')
    expect(toml).toContain('http_headers = { "Authorization" = "Bearer t0k" }')

    // stdio server: command + args array + env inline table.
    expect(toml).toContain('[mcp_servers."local"]')
    expect(toml).toContain('command = "run"')
    expect(toml).toContain('args = ["--flag"]')
    expect(toml).toContain('env = { "MCP_AUTH_TOKEN" = "sekret" }')
  })

  it("maps an sse connector onto codex's url-based (streamable HTTP) server", async () => {
    await writeCodexConfig(codexHome, { events: { type: "sse", url: "https://sse/" } })
    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8")
    expect(toml).toContain('[mcp_servers."events"]')
    expect(toml).toContain('url = "https://sse/"')
  })

  it("returns null and writes nothing when there are no servers", async () => {
    expect(await writeCodexConfig(codexHome, {})).toBeNull()
    await expect(readFile(path.join(codexHome, "config.toml"), "utf8")).rejects.toThrow()
  })
})
