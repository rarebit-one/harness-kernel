import { describe, it, expect, afterEach } from "vitest"
import { ProviderCredentialsError, providerAvailability, selectProvider } from "./index.js"

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

  it("FAILS LOUD when the preferred provider has no key — no more silent mock", () => {
    clearKeys()
    // Production ran like this for weeks: a payload naming anthropic, a host
    // with no key, and a run that completed on the mock while reporting
    // success. The consumer grew prediction code to tell the two apart.
    expect(() => selectProvider("anthropic")).toThrow(ProviderCredentialsError)
    expect(() => selectProvider("openrouter")).toThrow(/OPENROUTER_API_KEY/)
    try {
      selectProvider("anthropic")
    } catch (err) {
      const e = err as ProviderCredentialsError
      expect(e.preferred).toBe("anthropic")
      expect(e.missing).toEqual(["ANTHROPIC_API_KEY", "credentials.anthropic"])
      expect(e.message).toMatch(/credentials\.anthropic/)
    }
  })

  it("fails loud when nothing is configured and no preference is given", () => {
    clearKeys()
    expect(() => selectProvider(null)).toThrow(ProviderCredentialsError)
    expect(() => selectProvider(undefined)).toThrow(
      /ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY/,
    )
  })

  it("degrades to the mock only on an explicit allowMockFallback", () => {
    clearKeys()
    expect(selectProvider("anthropic", { allowMockFallback: true }).name).toBe("mock")
    expect(selectProvider(null, { allowMockFallback: true }).name).toBe("mock")
    // The opt-in never overrides a configured key.
    process.env.OPENAI_API_KEY = "sk-env"
    expect(selectProvider("openai", { allowMockFallback: true }).name).toBe("openai")
  })

  it("reports availability as a reason, mirroring what selectProvider would do", () => {
    clearKeys()
    expect(providerAvailability("anthropic")).toMatchObject({ ok: false })
    expect(providerAvailability("anthropic", { allowMockFallback: true })).toEqual({ ok: true })
    expect(providerAvailability("mock")).toEqual({ ok: true })
    expect(providerAvailability(null)).toMatchObject({ ok: false })
    const refused = providerAvailability("openrouter")
    expect(!refused.ok && refused.reason).toMatch(/OPENROUTER_API_KEY/)
    process.env.ANTHROPIC_API_KEY = "sk-env"
    expect(providerAvailability("anthropic")).toEqual({ ok: true })
    expect(providerAvailability(null)).toEqual({ ok: true })
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

  it("ignores the host env keys when envFallback is false", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    process.env.OPENAI_API_KEY = "sk-env"
    // A caller that resolves credentials itself sent none: the run fails
    // instead of landing on the host's unmetered key.
    expect(() => selectProvider("anthropic", { envFallback: false })).toThrow(
      ProviderCredentialsError,
    )
    expect(() => selectProvider(null, { envFallback: false })).toThrow(ProviderCredentialsError)
    expect(providerAvailability("openai", { envFallback: false })).toMatchObject({ ok: false })
    // The message and `missing` name only the slot that would satisfy it now.
    try {
      selectProvider("anthropic", { envFallback: false })
    } catch (err) {
      const e = err as ProviderCredentialsError
      expect(e.missing).toEqual(["credentials.anthropic"])
      expect(e.message).toMatch(/envFallback is false/)
      expect(e.message).not.toMatch(/ANTHROPIC_API_KEY/)
    }
    // A key passed with the run still wins, and the mock opt-in still applies.
    expect(
      selectProvider("anthropic", { envFallback: false, credentials: { anthropic: "sk-run" } })
        .name,
    ).toBe("anthropic")
    expect(selectProvider("anthropic", { envFallback: false, allowMockFallback: true }).name).toBe(
      "mock",
    )
    // Explicit true is the default.
    expect(selectProvider("anthropic", { envFallback: true }).name).toBe("anthropic")
  })

  it("keeps local on its env base URL and key when envFallback is false", () => {
    clearKeys()
    process.env.LOCAL_MODEL_BASE_URL = "http://localhost:11434/v1"
    expect(selectProvider("local", { envFallback: false }).name).toBe("local")
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

  it("does NOT fall through to another configured provider when the preferred one has no key", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    // A run that asked for one model and quietly got another is the same
    // failure as one that quietly got the mock.
    expect(() => selectProvider("openrouter")).toThrow(ProviderCredentialsError)
    // No preference still picks whatever is configured.
    expect(selectProvider(null).name).toBe("anthropic")
  })

  it("refuses a provider name it does not know, whatever keys or opt-ins are present", () => {
    clearKeys()
    process.env.ANTHROPIC_API_KEY = "sk-env"
    // A typo must not route to whichever key is configured.
    expect(() => selectProvider("openia")).toThrow(ProviderCredentialsError)
    expect(() => selectProvider("openia")).toThrow(/not one this kernel knows/)
    expect(() => selectProvider("gemini", { allowMockFallback: true })).toThrow(
      ProviderCredentialsError,
    )
    expect(providerAvailability("openia").ok).toBe(false)
    // Absent, null and blank still mean "no preference".
    expect(selectProvider("").name).toBe("anthropic")
    expect(selectProvider("  ").name).toBe("anthropic")
    expect(selectProvider(null).name).toBe("anthropic")
  })

  it("exposes the configured model on every built-in adapter", () => {
    clearKeys()
    expect(
      selectProvider("anthropic", { model: "m-a", credentials: { anthropic: "k" } }).model,
    ).toBe("m-a")
    expect(selectProvider("mock", { model: "m-m" }).model).toBe("m-m")
    expect(selectProvider("mock").model).toBeUndefined()
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
