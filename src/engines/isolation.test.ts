import { describe, expect, it } from "vitest"
import { acpEnv } from "./acpDriver.js"
import { claudeCodeEnv } from "./claudeCodeDriver.js"
import { codexEnv } from "./codexDriver.js"
import { childEnv, effectiveIsolation, refuseUnisolated } from "./isolation.js"

describe("effectiveIsolation", () => {
  it("is the weaker of the run's and the host's claim", () => {
    expect(effectiveIsolation({ isolation: "vm" }, { RUNNER_ISOLATION: "container" })).toBe(
      "container",
    )
    expect(effectiveIsolation({ isolation: "container" }, { RUNNER_ISOLATION: "vm" })).toBe(
      "container",
    )
    expect(effectiveIsolation({ isolation: "vm" }, { RUNNER_ISOLATION: "vm" })).toBe("vm")
  })

  it("counts an absent or unrecognised value on either side as none", () => {
    expect(effectiveIsolation({}, { RUNNER_ISOLATION: "vm" })).toBe("none")
    expect(effectiveIsolation({ isolation: "vm" }, {})).toBe("none")
    expect(effectiveIsolation({ isolation: "VM" }, { RUNNER_ISOLATION: "vm" })).toBe("none")
    expect(effectiveIsolation({ isolation: "vm" }, { RUNNER_ISOLATION: "microvm" })).toBe("none")
  })
})

describe("refuseUnisolated", () => {
  it("refuses below container, naming both claims", () => {
    const res = refuseUnisolated("codex", { isolation: "vm" }, { RUNNER_ISOLATION: "none" })
    expect(res?.ok).toBe(false)
    expect(res?.reason).toBe(
      "codex engine requires at least container isolation, but this run has none " +
        "(run: vm, host RUNNER_ISOLATION: none)",
    )
  })

  it("allows container and vm", () => {
    const env = { RUNNER_ISOLATION: "vm" }
    expect(refuseUnisolated("codex", { isolation: "container" }, env)).toBeUndefined()
    expect(refuseUnisolated("codex", { isolation: "vm" }, env)).toBeUndefined()
  })
})

describe("childEnv", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/agent",
    LC_ALL: "C.UTF-8",
    XDG_CONFIG_HOME: "/home/agent/.config",
    ANTHROPIC_BASE_URL: "https://gateway.example",
    RUN_TOKEN: "secret-callback-token",
    RUN_ID: "run-1",
    DATABASE_URL: "postgres://host",
    OPENAI_API_KEY: "host-openai-key",
  }

  it("keeps the base allowlist and the engine's prefixes, nothing else", () => {
    expect(childEnv(["ANTHROPIC_"], {}, host)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/agent/.config",
      ANTHROPIC_BASE_URL: "https://gateway.example",
    })
  })

  it("lets extra win and drops undefined extras", () => {
    const env = childEnv(
      ["ANTHROPIC_"],
      { ANTHROPIC_BASE_URL: "https://other", X: undefined },
      host,
    )
    expect(env.ANTHROPIC_BASE_URL).toBe("https://other")
    expect("X" in env).toBe(false)
  })

  it("never passes a credential-looking name through a prefix, only through extra", () => {
    const withKeys = {
      ...host,
      ANTHROPIC_API_KEY: "host-key",
      ANTHROPIC_ADMIN_API_KEY: "admin-key",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      ANTHROPIC_AUTH_TOKEN: "bearer",
      ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-header",
    }
    const env = childEnv(["ANTHROPIC_", "CLAUDE_"], {}, withKeys)
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_ADMIN_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
    expect(
      childEnv(["ANTHROPIC_"], { ANTHROPIC_API_KEY: "run-key" }, withKeys).ANTHROPIC_API_KEY,
    ).toBe("run-key")
  })

  it("never inherits a var outside its prefixes, even a provider key", () => {
    const env = childEnv(["ANTHROPIC_"], {}, host)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.RUN_TOKEN).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })
})

// Each driver spawns its harness through childEnv. These pin that wiring, so a
// driver reverted to `...process.env` fails here rather than passing silently.
describe("driver environments", () => {
  const host = {
    PATH: "/usr/bin",
    RUN_TOKEN: "secret-callback-token",
    ANTHROPIC_API_KEY: "host-anthropic",
    OPENAI_API_KEY: "host-openai",
    OPENAI_BASE_URL: "https://gateway.example/v1",
  }

  it("claude-code: the run's key, the CLI's own settings, never the host's tokens", () => {
    const env = claudeCodeEnv({ apiKey: "run-key" }, host)
    expect(env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "run-key" })
  })

  it("codex: CODEX_HOME, the capability env and the run's key", () => {
    const env = codexEnv(
      { codexHome: "/tmp/codex-home", capabilityEnv: { HARNESS_WORKDIR: "/w" }, apiKey: "run-key" },
      host,
    )
    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENAI_BASE_URL: "https://gateway.example/v1",
      CODEX_HOME: "/tmp/codex-home",
      HARNESS_WORKDIR: "/w",
      CODEX_API_KEY: "run-key",
      OPENAI_API_KEY: "run-key",
    })
  })

  it("acp: only the agent's declared prefixes and its explicit env", () => {
    const env = acpEnv({ env: { HARNESS_WORKDIR: "/w" }, inheritEnvPrefixes: ["OPENAI_"] }, host)
    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENAI_BASE_URL: "https://gateway.example/v1",
      HARNESS_WORKDIR: "/w",
    })
    expect(acpEnv({ env: {} }, host)).toEqual({ PATH: "/usr/bin" })
  })
})
