import { describe, it, expect, afterEach } from "vitest"
import { selectProvider } from "./index.js"

describe("selectProvider", () => {
  const saved = {
    a: process.env.ANTHROPIC_API_KEY,
    o: process.env.OPENAI_API_KEY,
    r: process.env.OPENROUTER_API_KEY,
    lb: process.env.LOCAL_MODEL_BASE_URL,
    lk: process.env.LOCAL_MODEL_API_KEY,
  }
  function clearKeys() {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.LOCAL_MODEL_BASE_URL
    delete process.env.LOCAL_MODEL_API_KEY
  }
  function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  afterEach(() => {
    restore("ANTHROPIC_API_KEY", saved.a)
    restore("OPENAI_API_KEY", saved.o)
    restore("OPENROUTER_API_KEY", saved.r)
    restore("LOCAL_MODEL_BASE_URL", saved.lb)
    restore("LOCAL_MODEL_API_KEY", saved.lk)
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

  it("selects local when a base URL is configured (no key required)", () => {
    clearKeys()
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:8080/v1"
    expect(selectProvider("local").name).toBe("local")
  })

  it("selects local from a per-org base URL + optional BYO key", () => {
    clearKeys()
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:8080/v1"
    expect(selectProvider("local", { credentials: { local: "sk-local" } }).name).toBe("local")
  })

  it("FAILS LOUD for local with no base URL — never degrades to the mock", () => {
    clearKeys()
    // Unlike every other provider, a missing local endpoint throws: the whole
    // point of `local` is to keep a private-inference run OFF another provider.
    expect(() => selectProvider("local")).toThrow(/LOCAL_MODEL_BASE_URL/)
  })
})
