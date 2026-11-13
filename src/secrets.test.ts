import { describe, it, expect } from "vitest"
import { connectorTools, maskToolOutput, secretMaskSet } from "./index.js"
import type { McpConnection } from "./connectors/mcpClient.js"
import type { Tool } from "./tools/registry.js"
import { MASKED_SECRET, secretsToEnv } from "./secrets.js"

describe("secretsToEnv", () => {
  it("maps secrets to an env object", () => {
    expect(secretsToEnv({ API_KEY: "x", TOKEN: "y" })).toEqual({ API_KEY: "x", TOKEN: "y" })
  })

  it("returns an empty object when given nothing", () => {
    expect(secretsToEnv()).toEqual({})
  })
})

describe("secretMaskSet", () => {
  it("masks the starting secrets, and a value added later from then on", () => {
    const secrets = secretMaskSet({ API_TOKEN: "tok_start_123", REGION: "eu" })
    expect(secrets.mask("a tok_start_123 b eu")).toBe(`a ${MASKED_SECRET} b eu`)
    expect(secrets.mask("rotated tok_later_456")).toBe("rotated tok_later_456")

    secrets.add("tok_later_456")
    secrets.add("tiny")
    expect(secrets.mask("rotated tok_later_456 tiny")).toBe(`rotated ${MASKED_SECRET} tiny`)
  })

  it("masks a value containing another whole, and its JSON-escaped form", () => {
    const secrets = secretMaskSet()
    secrets.add("abcdef")
    secrets.add('Bearer abcdef"x')
    expect(secrets.mask('Bearer abcdef"x')).toBe(MASKED_SECRET)
    expect(secrets.mask(JSON.stringify('Bearer abcdef"x'))).toBe(`"${MASKED_SECRET}"`)
  })
})

describe("maskToolOutput", () => {
  const echo = (text: string): Tool => ({
    spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
    execute: async () => text,
    executeStructured: async () => ({ content: text, structured: { raw: text } }),
  })

  it("masks what a tool returns, and only the model-facing content of a structured result", async () => {
    const secrets = secretMaskSet({ TOKEN: "tok_abc_123" })
    const [tool] = maskToolOutput([echo("got tok_abc_123")], secrets.mask)
    expect(await tool!.execute({})).toBe(`got ${MASKED_SECRET}`)
    expect(await tool!.executeStructured!({})).toEqual({
      content: `got ${MASKED_SECRET}`,
      structured: { raw: "got tok_abc_123" },
    })
  })

  it("masks a thrown message, and rethrows an error that held no secret as itself", async () => {
    const secrets = secretMaskSet({ TOKEN: "tok_abc_123" })
    const abort = new DOMException("aborted", "AbortError")
    const throwing = (err: unknown): Tool => ({
      spec: { name: "t", description: "t", inputSchema: { type: "object" } },
      execute: async () => {
        throw err
      },
    })
    const [leaky, plain] = maskToolOutput(
      [throwing(new Error("401 for tok_abc_123")), throwing(abort)],
      secrets.mask,
    )
    await expect(leaky!.execute({})).rejects.toThrow(`401 for ${MASKED_SECRET}`)
    await expect(plain!.execute({})).rejects.toBe(abort)
  })

  it("masks a connector credential reported mid-run, used directly with connectorTools", async () => {
    // The direct-use recipe: the connection reports the credential it sends
    // through onSecret, and the wrapped tools mask it from then on.
    let report: ((value: string) => void) | undefined
    const conn: McpConnection = {
      listTools: async () => ({ tools: [{ name: "whoami", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "text", text: "token=tok_rotated_456" }] }),
      close: async () => {},
    }
    const secrets = secretMaskSet()
    const { tools, close } = await connectorTools(
      [{ name: "svc", kind: "mcp", transport: "streamable_http", endpoint: "https://x" }],
      async (_config, opts) => {
        report = opts?.onSecret
        return conn
      },
      { onSecret: secrets.add },
    )
    const [whoami] = maskToolOutput(tools, secrets.mask)
    expect(await whoami!.execute({})).toContain("tok_rotated_456")

    report?.("tok_rotated_456")
    expect(await whoami!.execute({})).toContain(`token=${MASKED_SECRET}`)
    await close()
  })
})
