import { describe, it, expect, afterEach } from "vitest"
import { selectProvider } from "./index.js"

describe("selectProvider", () => {
  const saved = {
    a: process.env.ANTHROPIC_API_KEY,
    o: process.env.OPENAI_API_KEY,
    r: process.env.OPENROUTER_API_KEY,
  }
  function clearKeys() {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
  }
  afterEach(() => {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved.a
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.o
    if (saved.r === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = saved.r
  })

  it("degrades to the offline mock when no key is configured", () => {
    clearKeys()
    expect(selectProvider("anthropic").name).toBe("mock")
    expect(selectProvider("openrouter").name).toBe("mock")
  })

  it("uses a per-org BYO key even when no env key is set", () => {
    clearKeys()
    const anthropic = selectProvider("anthropic", {
      credentials: { anthropic: "sk-org-anthropic" },
    })
    expect(anthropic.name).toBe("anthropic")
    const openai = selectProvider("openai", { credentials: { openai: "sk-org-openai" } })
    expect(openai.name).toBe("openai")
    const openrouter = selectProvider("openrouter", {
      credentials: { openrouter: "sk-org-openrouter" },
    })
    expect(openrouter.name).toBe("openrouter")
  })

  it("falls back to the runner env key when the org has no BYO key", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    expect(selectProvider("anthropic").name).toBe("anthropic")
  })

  it("selects openrouter from OPENROUTER_API_KEY when preferred", () => {
    clearKeys()
    process.env.OPENROUTER_API_KEY = "sk-env-openrouter"
    expect(selectProvider("openrouter").name).toBe("openrouter")
  })

  it("selects openrouter with no preference when it is the only configured key", () => {
    clearKeys()
    process.env.OPENROUTER_API_KEY = "sk-env-openrouter"
    expect(selectProvider(null).name).toBe("openrouter")
  })

  it("falls through to a configured provider when the preferred one has no key", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    expect(selectProvider("openrouter").name).toBe("anthropic")
  })

  it("honours an explicit preferred=mock even when a key is configured", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    // `preferred: mock` is the offline dry-run lens; it must not silently upgrade
    // to a real provider just because a key happens to be present.
    expect(selectProvider("mock").name).toBe("mock")
    expect(selectProvider("mock", { credentials: { anthropic: "sk-org" } }).name).toBe("mock")
  })
})
