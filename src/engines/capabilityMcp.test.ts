import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { capabilityTools } from "./capability.js"
import { CAPABILITY_SERVER_NAME, capabilitySdkServer, capabilityToolIds } from "./capabilityMcp.js"

describe("capabilityMcp", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "capmcp-test-"))
  })
  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })

  it("namespaces tool ids under the workspace server", () => {
    const tools = capabilityTools({ workspaceId: "w", workdir, issues: [], knowledge: [] })
    expect(capabilityToolIds(tools).sort()).toEqual(
      [
        "mcp__workspace__open_issue",
        "mcp__workspace__promote_knowledge",
        "mcp__workspace__write_file",
      ].sort(),
    )
  })

  it("builds an in-process SDK MCP server carrying the capabilities", async () => {
    const tools = capabilityTools({ workspaceId: "w", workdir, issues: [], knowledge: [] })
    const server = await capabilitySdkServer(tools)
    expect(server.type).toBe("sdk")
    expect(server.name).toBe(CAPABILITY_SERVER_NAME)
    expect(server.instance).toBeDefined()
  })
})
