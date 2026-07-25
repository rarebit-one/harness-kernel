import { describe, it, expect, afterEach } from "vitest"
import { MockProvider } from "./mock.js"

// The mock is the offline dry-run lens: it can't call a model, but it echoes the
// model + BYO key the caller RESOLVED, so an e2e harness can assert key
// precedence from the run's output artifact.
describe("MockProvider", () => {
  const req = { system: "sys", messages: [{ role: "user" as const, text: "hi" }], tools: [] }
  const saved = {
    a: process.env.ANTHROPIC_MODEL,
    o: process.env.OPENAI_MODEL,
    r: process.env.OPENROUTER_MODEL,
  }
  afterEach(() => {
    for (const [k, v] of [
      ["ANTHROPIC_MODEL", saved.a],
      ["OPENAI_MODEL", saved.o],
      ["OPENROUTER_MODEL", saved.r],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  function clearEnvModels() {
    delete process.env.ANTHROPIC_MODEL
    delete process.env.OPENAI_MODEL
    delete process.env.OPENROUTER_MODEL
  }

  it("echoes the resolved per-run model as 'would be used'", async () => {
    clearEnvModels()
    const { text } = await new MockProvider({ model: "claude-opus-4-8" }).converse(req)
    expect(text).toContain("model: claude-opus-4-8 (resolved; would be used)")
  })

  it("falls back to the runner env-default model when none was resolved", async () => {
    clearEnvModels()
    process.env.ANTHROPIC_MODEL = "env-default-model"
    const { text } = await new MockProvider({ model: null }).converse(req)
    expect(text).toContain("model: env-default-model (runner env default; would be used)")
  })

  it("notes the provider built-in default when neither run nor env sets a model", async () => {
    clearEnvModels()
    const { text } = await new MockProvider().converse(req)
    expect(text).toContain("(provider built-in default; would be used)")
  })

  it("marks the org BYO key by last-4 only, never the key itself", async () => {
    clearEnvModels()
    const { text } = await new MockProvider({
      model: "m",
      credentials: { anthropic: "sk-secret-tail-9876" },
    }).converse(req)
    expect(text).toContain("org BYO key: anthropic:…9876")
    expect(text).not.toContain("sk-secret-tail-9876")
  })

  it("reports no BYO key when the org set none", async () => {
    clearEnvModels()
    const { text } = await new MockProvider({ model: "m" }).converse(req)
    expect(text).toContain("org BYO key: (none — runner env key would be used)")
  })
})
