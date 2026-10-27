import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AnthropicProvider } from "../providers/anthropic.js"
import { selectProvider } from "../providers/index.js"
import { OpenAIProvider } from "../providers/openai.js"
import { OpenRouterProvider } from "../providers/openrouter.js"
import { AcpEngine, EVE_AGENT, type AcpDriver, type AcpOptions } from "./acp.js"
import { acpEnv } from "./acpDriver.js"
import { ClaudeCodeEngine, type ClaudeCodeMessage, type ClaudeCodeOptions } from "./claudeCode.js"
import { claudeCodeEnv } from "./claudeCodeDriver.js"
import { CodexEngine, type CodexMessage, type CodexOptions } from "./codex.js"
import { codexEnv } from "./codexDriver.js"
import {
  gatewayEnv,
  gatewayProblem,
  gatewayRoute,
  refuseRawCredentialsInVm,
  withoutShadowed,
  type RunGateway,
} from "./gateway.js"
import { NativeEngine, providerSelection } from "./native.js"
import type { RunSpec } from "./types.js"

const GATEWAY: RunGateway = { baseUrl: "https://gw.example.com/", runToken: "rt_run-token-123" }
const SCRIPT = "/opt/harness/capabilityStdio.js"

/**
 * Every value here is a real credential (or a route around the gateway) that
 * must NEVER reach a harness once the run has a gateway. Each carries a marker
 * so a leak is found by substring, wherever in the env it lands.
 */
const HOST_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/runner",
  ANTHROPIC_API_KEY: "sk-ant-LEAK-host",
  ANTHROPIC_BASE_URL: "https://LEAK-bypass.example.com",
  ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-LEAK-header",
  OPENAI_API_KEY: "sk-oai-LEAK-host",
  OPENAI_BASE_URL: "https://LEAK-bypass.example.com/v1",
  OPENROUTER_API_KEY: "sk-or-LEAK-host",
  CODEX_API_KEY: "sk-codex-LEAK-host",
  CLAUDE_CODE_OAUTH_TOKEN: "LEAK-oauth",
  EVE_MODEL: "kept-config",
}
const BYO = {
  anthropic: "sk-ant-LEAK-byo",
  openai: "sk-oai-LEAK-byo",
  openrouter: "sk-or-LEAK-byo",
}

function spec(workdir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "ws",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do it.", runner: { profile: "ephemeral" } },
    inputs: {},
    context: "",
    workdir,
    permissions: {},
    secrets: {},
    connectors: [],
    provider: { credentials: { ...BYO } },
    ...overrides,
  }
}

/** Run `fn` with `vars` set on process.env, restoring every one afterwards. */
async function withEnv<T>(vars: NodeJS.ProcessEnv, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function expectNoLeak(env: Record<string, string>) {
  const dump = JSON.stringify(env)
  expect(dump).not.toContain("LEAK")
  expect(dump).toContain(GATEWAY.runToken)
}

describe("withoutShadowed", () => {
  it("drops prefixes inside or around a shadowed one, keeping the rest", () => {
    expect(
      withoutShadowed(["ANTHROPIC", "ANTHROPIC_BASE", "OPENAI_", "OPEN", "A", "", "HOME", "XDG_"]),
    ).toEqual(["HOME", "XDG_"])
  })
})

describe("gateway routes", () => {
  it("defaults each provider to <baseUrl>/p/<provider>, and honours an override", () => {
    expect(gatewayRoute(GATEWAY, "anthropic")).toBe("https://gw.example.com/p/anthropic")
    expect(gatewayRoute({ ...GATEWAY, baseUrl: "https://gw.example.com///" }, "openai")).toBe(
      "https://gw.example.com/p/openai",
    )
    expect(
      gatewayRoute({ ...GATEWAY, routes: { openai: "https://other.example.com/oai" } }, "openai"),
    ).toBe("https://other.example.com/oai")
  })

  it("points each provider's base URL at its route with the run token as its key", () => {
    expect(gatewayEnv(GATEWAY, ["anthropic", "openai"])).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example.com/p/anthropic",
      ANTHROPIC_API_KEY: GATEWAY.runToken,
      OPENAI_BASE_URL: "https://gw.example.com/p/openai",
      OPENAI_API_KEY: GATEWAY.runToken,
    })
  })

  it.each([
    [{ ...GATEWAY, runToken: "" }, /no run token/],
    [{ ...GATEWAY, baseUrl: "gw.example.com" }, /baseUrl is not an http\(s\) URL/],
    [{ ...GATEWAY, routes: { openai: "ftp://x" } }, /routes.openai is not an http\(s\) URL/],
    [{ ...GATEWAY, routes: { mistral: "https://x" } as never }, /does not know: mistral/],
  ])("finds a malformed gateway unusable (%#)", (gateway, problem) => {
    expect(gatewayProblem({ gateway })).toMatch(problem)
  })

  it("has no problem with a well-formed gateway or none at all", () => {
    expect(gatewayProblem({ gateway: GATEWAY })).toBeUndefined()
    expect(gatewayProblem({})).toBeUndefined()
  })
})

describe("refuseRawCredentialsInVm", () => {
  const base = { provider: {} as RunSpec["provider"] }

  it("refuses a vm run holding a BYO key, naming the slot and never the value", () => {
    const refusal = refuseRawCredentialsInVm("codex", {
      ...base,
      isolation: "vm",
      provider: { credentials: { openai: "sk-oai-LEAK-byo" } },
    })
    expect(refusal?.reason).toContain("provider.credentials.openai")
    expect(refusal?.reason).not.toContain("LEAK")
  })

  it("refuses a vm run whose host holds the engine's fallback key", () => {
    const refusal = refuseRawCredentialsInVm(
      "codex",
      { ...base, isolation: "vm" },
      ["OPENAI_API_KEY"],
      {
        OPENAI_API_KEY: "sk-oai-LEAK-host",
      },
    )
    expect(refusal?.reason).toContain("host OPENAI_API_KEY")
    expect(refusal?.reason).not.toContain("LEAK")
  })

  it("lets a vm run through when it has a gateway, or no raw credentials at all", () => {
    expect(
      refuseRawCredentialsInVm("codex", {
        isolation: "vm",
        gateway: GATEWAY,
        provider: { credentials: BYO },
      }),
    ).toBeUndefined()
    expect(
      refuseRawCredentialsInVm("codex", { ...base, isolation: "vm" }, ["OPENAI_API_KEY"], {}),
    ).toBeUndefined()
  })

  it("does not apply below vm", () => {
    expect(
      refuseRawCredentialsInVm("codex", { isolation: "container", provider: { credentials: BYO } }),
    ).toBeUndefined()
  })
})

describe("engines refuse a vm run with raw credentials and no gateway", () => {
  const flags = {
    RUNNER_ENABLE_CLAUDE_CODE: "1",
    RUNNER_ENABLE_CODEX: "1",
    RUNNER_ENABLE_EVE: "1",
    RUNNER_ISOLATION: "vm",
  }
  const engines = [
    ["native", () => new NativeEngine()],
    ["claude-code", () => new ClaudeCodeEngine()],
    ["codex", () => new CodexEngine(undefined, SCRIPT)],
    ["eve", () => new AcpEngine(EVE_AGENT, SCRIPT)],
  ] as const

  it.each(engines)("%s", async (name, make) => {
    await withEnv(flags, () => {
      const engine = make()
      const refused = engine.supports(spec("/sandbox", { isolation: "vm" }))
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.reason).toMatch(new RegExp(`${name} engine refuses a vm run`))
      expect(!refused.ok && refused.reason).not.toContain("LEAK")
      // The same run through a gateway is accepted.
      expect(engine.supports(spec("/sandbox", { isolation: "vm", gateway: GATEWAY }))).toEqual({
        ok: true,
      })
    })
  })

  it.each(engines)("%s refuses a malformed gateway instead of ignoring it", async (_name, make) => {
    await withEnv(flags, () => {
      const refused = make().supports(
        spec("/sandbox", { isolation: "vm", gateway: { ...GATEWAY, runToken: "" } }),
      )
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.reason).toMatch(
        /cannot use this run's gateway: gateway has no run token/,
      )
    })
  })
})

describe("env dump: no real credential reaches a harness through a gateway", () => {
  let workdir: string
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "gw-wd-"))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it("claude-code", async () => {
    let seen: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      seen = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    // The host's own key is on process.env too: the engine must not fall back to it.
    await withEnv(HOST_ENV, () =>
      new ClaudeCodeEngine(driver).run(spec(workdir, { gateway: GATEWAY }), { log: () => {} }),
    )
    expect(seen?.apiKey).toBeUndefined()
    const env = claudeCodeEnv(seen!, HOST_ENV)
    expectNoLeak(env)
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw.example.com/p/anthropic")
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY.runToken)
  })

  it("codex", async () => {
    let seen: CodexOptions | undefined
    async function* driver(opts: CodexOptions): AsyncIterable<CodexMessage> {
      seen = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    await withEnv(HOST_ENV, () =>
      new CodexEngine(driver, SCRIPT).run(spec(workdir, { gateway: GATEWAY }), { log: () => {} }),
    )
    expect(seen?.apiKey).toBeUndefined()
    const env = codexEnv(seen!, HOST_ENV)
    expectNoLeak(env)
    expect(env.OPENAI_BASE_URL).toBe("https://gw.example.com/p/openai")
    expect(env.CODEX_API_KEY).toBe(GATEWAY.runToken)
  })

  it("an ACP agent", async () => {
    let seen: AcpOptions | undefined
    const drive = (async (opts: AcpOptions) => {
      seen = opts
      return { stopReason: "end_turn" }
    }) as AcpDriver
    await new AcpEngine(EVE_AGENT, SCRIPT, drive).run(spec(workdir, { gateway: GATEWAY }), {
      log: () => {},
    })
    const env = acpEnv(seen!, HOST_ENV)
    expectNoLeak(env)
    expect(env.OPENROUTER_BASE_URL).toBe("https://gw.example.com/p/openrouter")
    // The agent's own non-credential config still passes.
    expect(env.EVE_MODEL).toBe("kept-config")
  })

  it("the same engines without a gateway behave exactly as before", async () => {
    let seen: ClaudeCodeOptions | undefined
    async function* driver(opts: ClaudeCodeOptions): AsyncIterable<ClaudeCodeMessage> {
      seen = opts
      yield { kind: "result", text: "ok", isError: false }
    }
    await new ClaudeCodeEngine(driver).run(spec(workdir), { log: () => {} })
    expect(seen?.apiKey).toBe(BYO.anthropic)
    expect(seen?.gatewayEnv).toBeUndefined()
    expect(claudeCodeEnv(seen!, HOST_ENV).ANTHROPIC_API_KEY).toBe(BYO.anthropic)
  })
})

describe("native engine through a gateway", () => {
  it("keys every cloud adapter with the run token and routes it, dropping BYO keys", () => {
    const selection = providerSelection(spec("/sandbox", { gateway: GATEWAY }))
    expect(JSON.stringify(selection)).not.toContain("LEAK")
    expect(selection.credentials).toEqual({
      anthropic: GATEWAY.runToken,
      openai: GATEWAY.runToken,
      openrouter: GATEWAY.runToken,
    })
    expect(selection.baseURLs?.openrouter).toBe("https://gw.example.com/p/openrouter")
  })

  it("keeps the local key: private inference is not routed", () => {
    const selection = providerSelection(
      spec("/sandbox", { gateway: GATEWAY, provider: { credentials: { local: "lk" } } }),
    )
    expect(selection.credentials?.local).toBe("lk")
  })

  it("pins an unset preference to the provider the run would resolve without the gateway", () => {
    const noHostKeys = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" }
    const openaiOnly = spec("/sandbox", {
      gateway: GATEWAY,
      provider: { credentials: { openai: "sk-oai-LEAK-byo" } },
    })
    expect(providerSelection(openaiOnly, noHostKeys).preferred).toBe("openai")
    const hostOpenRouter = spec("/sandbox", { gateway: GATEWAY, provider: {} })
    expect(
      providerSelection(hostOpenRouter, { ...noHostKeys, OPENROUTER_API_KEY: "sk-or-LEAK-host" })
        .preferred,
    ).toBe("openrouter")
    const explicit = spec("/sandbox", {
      gateway: GATEWAY,
      provider: { preferred: "openrouter", credentials: { openai: "sk-oai-LEAK-byo" } },
    })
    expect(providerSelection(explicit, noHostKeys).preferred).toBe("openrouter")
  })

  it("hands out no run token when nothing would resolve, so the run still fails loud", async () => {
    const keyless = spec("/sandbox", { gateway: GATEWAY, provider: {} })
    const selection = providerSelection(keyless, {})
    expect(selection.credentials).toEqual({})
    await withEnv({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" }, () => {
      const support = new NativeEngine().supports(keyless)
      expect(support.ok).toBe(false)
      expect(!support.ok && support.reason).toMatch(/no provider credential is configured/)
    })
  })

  it("is the plain selection without a gateway", () => {
    const s = spec("/sandbox")
    expect(providerSelection(s)).toBe(s.provider)
  })

  it("builds adapters that send to the route", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" }, () => {
      const selection = providerSelection(spec("/sandbox", { gateway: GATEWAY }))
      for (const [preferred, route] of [
        ["anthropic", "https://gw.example.com/p/anthropic"],
        ["openai", "https://gw.example.com/p/openai"],
        ["openrouter", "https://gw.example.com/p/openrouter"],
      ] as const) {
        const provider = selectProvider(preferred, selection) as unknown as {
          client: { baseURL: string; apiKey: string }
        }
        expect(provider.client.baseURL).toBe(route)
        expect(provider.client.apiKey).toBe(GATEWAY.runToken)
      }
    })
  })

  it("leaves each adapter on its default endpoint without a base URL", async () => {
    // The SDKs themselves honour a host base-URL var; clear them to see the default.
    await withEnv({ ANTHROPIC_BASE_URL: undefined, OPENAI_BASE_URL: undefined }, () => {
      const url = (p: unknown) => (p as { client: { baseURL: string } }).client.baseURL
      expect(url(new AnthropicProvider("k"))).toBe("https://api.anthropic.com")
      expect(url(new OpenAIProvider("k"))).toBe("https://api.openai.com/v1")
      expect(url(new OpenRouterProvider("k"))).toBe("https://openrouter.ai/api/v1")
    })
  })

  it("overrides a host base-URL var the SDK would otherwise honour", async () => {
    await withEnv({ ANTHROPIC_BASE_URL: "https://LEAK-bypass.example.com" }, () => {
      const p = new AnthropicProvider("k", undefined, "https://gw.example.com/p/anthropic")
      expect((p as unknown as { client: { baseURL: string } }).client.baseURL).toBe(
        "https://gw.example.com/p/anthropic",
      )
    })
  })
})

// Regressions from the independent review (REVIEW.md F5, F6); each began as
// the reviewer's repro, which asserted nothing and printed `{"ok":true}`.
describe("review regressions: vm credential refusals", () => {
  const vmFlags = { RUNNER_ENABLE_CLAUDE_CODE: "1", RUNNER_ISOLATION: "vm" }

  it("native refuses a vm run whose host holds the local provider's key", async () => {
    await withEnv(
      {
        LOCAL_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
        LOCAL_MODEL_API_KEY: "lk-LEAK-host",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
      },
      () => {
        const refused = new NativeEngine().supports(
          spec("/tmp", { isolation: "vm", provider: { preferred: "local" } }),
        )
        expect(refused.ok).toBe(false)
        expect(!refused.ok && refused.reason).toContain("host LOCAL_MODEL_API_KEY")
        expect(!refused.ok && refused.reason).not.toContain("LEAK")
      },
    )
  })

  it("F5: a private native vm run with a raw cloud key is refused like any other", async () => {
    await withEnv({ LOCAL_MODEL_BASE_URL: "http://127.0.0.1:11434/v1" }, () => {
      const refused = new NativeEngine().supports(
        spec("/tmp", {
          private: true,
          isolation: "vm",
          provider: { preferred: "local", credentials: { anthropic: "sk-ant-LEAK" } },
        }),
      )
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.reason).toMatch(
        /native engine refuses a vm run holding raw model credentials \(provider.credentials.anthropic\)/,
      )
      expect(!refused.ok && refused.reason).not.toContain("LEAK")
    })
  })

  it("F5: a private native run with a malformed gateway is refused", async () => {
    await withEnv({ LOCAL_MODEL_BASE_URL: "http://127.0.0.1:11434/v1" }, () => {
      const refused = new NativeEngine().supports(
        spec("/tmp", {
          private: true,
          provider: { preferred: "local" },
          gateway: { ...GATEWAY, baseUrl: "not-a-url" },
        }),
      )
      expect(!refused.ok && refused.reason).toMatch(/cannot use this run's gateway/)
    })
  })

  it("F5: a private native run that is clean still passes (local inference only)", async () => {
    await withEnv(
      {
        LOCAL_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      () => {
        expect(
          new NativeEngine().supports(
            spec("/tmp", { private: true, isolation: "vm", provider: { preferred: "local" } }),
          ),
        ).toEqual({ ok: true })
      },
    )
  })

  it("F6: vm + gateway + an exposed secret and connector bearer is refused, naming them only", async () => {
    await withEnv(vmFlags, () => {
      const refused = new ClaudeCodeEngine().supports(
        spec("/tmp", {
          isolation: "vm",
          gateway: GATEWAY,
          provider: {},
          secrets: { STRIPE_KEY: "sk_live_LEAK" },
          connectors: [
            {
              name: "c",
              kind: "mcp",
              transport: "streamable_http",
              endpoint: "https://mcp.example.com",
              auth: { type: "bearer", token: "LEAK-OAUTH" },
            },
            // The reviewer's shape: headers a caller's connector type adds.
            {
              name: "h",
              type: "http",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer LEAK-OAUTH" },
            } as never,
          ],
        }),
      )
      expect(refused.ok).toBe(false)
      const reason = !refused.ok ? refused.reason : ""
      expect(reason).toContain("claude-code engine refuses a vm run holding exposed credentials")
      expect(reason).toContain("secret STRIPE_KEY")
      expect(reason).toContain("connector c auth.token")
      expect(reason).toContain("connector h headers")
      expect(reason).not.toContain("LEAK")
    })
  })

  it("F6: the explicit policy allowance lets the same run through", async () => {
    await withEnv(vmFlags, () => {
      expect(
        new ClaudeCodeEngine().supports(
          spec("/tmp", {
            isolation: "vm",
            gateway: GATEWAY,
            provider: {},
            secrets: { STRIPE_KEY: "sk_live_x" },
            exposedCredentials: "allowed",
          }),
        ),
      ).toEqual({ ok: true })
    })
  })

  it("F6: a connector routed through the gateway (token = run token) is not exposed", async () => {
    await withEnv(vmFlags, () => {
      expect(
        new ClaudeCodeEngine().supports(
          spec("/tmp", {
            isolation: "vm",
            gateway: GATEWAY,
            provider: {},
            connectors: [
              {
                name: "routed",
                kind: "mcp",
                transport: "streamable_http",
                endpoint: "https://gw.example.com/c/routed",
                auth: { type: "bearer", token: GATEWAY.runToken },
              },
            ],
          }),
        ),
      ).toEqual({ ok: true })
    })
  })

  it("F6: exposed credentials are untouched below vm", async () => {
    await withEnv({ RUNNER_ENABLE_CLAUDE_CODE: "1", RUNNER_ISOLATION: "container" }, () => {
      expect(
        new ClaudeCodeEngine().supports(
          spec("/tmp", { isolation: "container", secrets: { STRIPE_KEY: "sk_live_x" } }),
        ),
      ).toEqual({ ok: true })
    })
  })

  it.each([
    ["native", () => new NativeEngine()],
    ["codex", () => new CodexEngine(undefined, SCRIPT)],
    ["eve", () => new AcpEngine(EVE_AGENT, SCRIPT)],
  ] as const)("F6: %s refuses an exposed secret under vm too", async (name, make) => {
    await withEnv(
      { RUNNER_ENABLE_CODEX: "1", RUNNER_ENABLE_EVE: "1", RUNNER_ISOLATION: "vm" },
      () => {
        const refused = make().supports(
          spec("/tmp", {
            isolation: "vm",
            gateway: GATEWAY,
            provider: { preferred: "anthropic" },
            secrets: { TOKEN: "x" },
          }),
        )
        expect(!refused.ok && refused.reason).toMatch(
          new RegExp(
            `${name} engine refuses a vm run holding exposed credentials \\(secret TOKEN\\)`,
          ),
        )
      },
    )
  })
})
