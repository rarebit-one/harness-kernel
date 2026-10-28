import { refusePrivateRun } from "../private.js"
import { refuseUnisolated } from "./isolation.js"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { McpServer } from "@zed-industries/agent-client-protocol"
import type { RunOutcome } from "../events.js"
import type { StoppedBy } from "../signals.js"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"
import { CAPABILITY_SERVER_NAME } from "./capabilityMcp.js"
import { connectorServers, type SerializableMcpServer } from "./connectorMcp.js"
import { readEmissions } from "./capabilityEmissions.js"
import { defaultAcpDriver } from "./acpDriver.js"
import { harnessPrompt } from "./harnessPrompt.js"
import { environmentInstructions } from "./environment.js"
import { gatewayEnv, refuseBadGateway, refuseCredentialsInVm, withoutShadowed } from "./gateway.js"

const LOG_TRUNCATE = 2000

/**
 * A named external agent this engine can drive over the Agent Client Protocol.
 * ACP is a JSON-RPC-over-stdio protocol between a *client* (this engine) and a
 * coding *agent* running as a separate process, so every ACP agent reduces to
 * "which subprocess to spawn, with what argv and env". The capability MCP server
 * and the run's connectors are handed to the agent through `session/new`, so a
 * spec never has to describe those — only its own launch.
 *
 * External agent product names appearing here follow the existing `claude-code`
 * / `codex` precedent: an adapter's honest identity is the tool it drives, not a
 * consumer's brand.
 */
export interface AcpAgentSpec {
  /** Engine name; also the `provider.engine` value that selects it. */
  readonly name: string
  /** Env var that must equal `"1"` for {@link AcpEngine.supports} to allow this agent. */
  readonly enableEnv: string
  /** The executable to spawn — an ACP server over stdio. */
  readonly command: string
  /** The process argv for a run (e.g. the ACP subcommand). */
  args(spec: RunSpec): string[]
  /** Extra process env — e.g. the provider credentials the agent reads for itself. */
  env(spec: RunSpec): Record<string, string>
  /**
   * Prefixes of host env vars the agent may inherit (its own configuration).
   * Credential-looking names under them are still dropped, but that filter is
   * best effort (see `childEnv`), so keep each prefix as narrow as the agent's
   * own settings.
   */
  readonly inheritEnvPrefixes?: readonly string[]
  /**
   * Host env keys the agent reads as its provider credentials — the keys its
   * `env()` function explicitly copies from `process.env` in non-gateway mode.
   * These are checked in `supports()` when `isolation` is `"vm"`, to refuse a
   * run holding raw model credentials in the host env. Absent means the spec
   * reads no host keys (it reads only from `spec.provider.credentials`).
   */
  readonly hostKeyEnvs?: readonly string[]
  /**
   * When `false`, this agent has no gateway route: `RunSpec.gateway` would cover
   * none of its provider keys, leaving the agent keyless at runtime. `supports()`
   * refuses such a run rather than starting the agent without credentials.
   * Absent (or `true`) means gateway runs are allowed; the agent's provider env
   * is built with `gatewayEnv` as usual.
   */
  readonly gatewaySupported?: boolean
  /**
   * When `true`, the agent does not discover the workdir's `AGENTS.md` files by
   * itself (it reads another context file by default), so the root and scoped
   * `AGENTS.md` contents are inlined into the prompt's instructions, the way
   * the Claude Code engine appends them. Absent (or `false`) means the agent
   * reads `AGENTS.md` from the workdir and only the system instructions and
   * skills index lead the prompt.
   */
  readonly promptAgentsMd?: boolean
}

/**
 * Driver-neutral options the engine derives from a {@link RunSpec} and hands to
 * the ACP driver. The default driver spawns `command`+`args` and speaks ACP over
 * its stdio; tests inject a fake driver and assert this mapping.
 */
export interface AcpOptions {
  command: string
  args: string[]
  /** Env the agent gets on top of the allowlisted host env (see `childEnv`). */
  env: Record<string, string>
  /** Prefixes of host env vars the agent may inherit; from {@link AcpAgentSpec}. */
  inheritEnvPrefixes?: readonly string[]
  /** The prepared sandbox working tree — the agent's cwd and ACP `session/new` cwd. */
  cwd: string
  /** The run's MCP servers (connectors + the capability server) for `session/new`. */
  mcpServers: McpServer[]
  /** The task prompt (workflow prompt + inputs). */
  prompt: string
  /** Wall-clock budget in ms; undefined means no engine-imposed limit. */
  maxDurationMs?: number
  /** Append a line to the run log (the driver surfaces the agent's stderr here). */
  log: (line: string) => void
  /** The caller's cancel; the driver merges it with its own `maxDurationMs` timer. */
  signal?: AbortSignal
  /**
   * How long the agent gets to answer `session/cancel` after a stop before its
   * process is killed. Defaults to 5s. Bounds every stop, so a hung agent
   * cannot keep a canceled or timed-out run alive.
   */
  cancelGraceMs?: number
}

/** Streaming callbacks the driver invokes as ACP `session/update`s arrive. */
export interface AcpClientEvents {
  /** An `agent_message_chunk` — accumulated into the run's prose result. */
  onAssistantChunk(text: string): void
  /** A human-readable line for the run log (thoughts, tool-call titles). */
  onLog(line: string): void
}

/** What one ACP prompt turn resolved to. */
export interface AcpOutcome {
  /** The ACP `stopReason` (`end_turn`, `cancelled`, `refusal`, …). */
  stopReason: string
  /** Set when the driver stopped the turn itself: its own timer
   *  (`"deadline"`) or the caller's signal (`"signal"`). */
  stoppedBy?: StoppedBy
}

/** The injectable boundary to the ACP transport. Tests supply a fake. */
export type AcpDriver = (opts: AcpOptions, events: AcpClientEvents) => Promise<AcpOutcome>

/**
 * Drives a run with any ACP-speaking coding agent (Claude Code, Codex, eve, …)
 * against the sandbox working tree. One engine, one transport: where the codex
 * engine wrote a `config.toml` and the Claude Code engine mounted an in-process
 * SDK MCP server, this hands the run's connectors + the runner-hosted capability
 * server to the agent through the ACP `session/new` `mcpServers` field, and reads
 * back the capability server's emissions file — so an ACP agent reaches emit
 * parity with native.
 *
 * Because an ACP agent runs arbitrary code, `supports()` refuses unless the
 * operator enabled this specific agent AND the run is on the ephemeral runner
 * profile (one throwaway container per run is the safety boundary). File edits
 * are out-of-band: the agent edits `cwd` directly and the caller's change-set
 * diff captures them, so this engine advertises no client filesystem capability.
 */
export class AcpEngine implements AgentEngine {
  readonly name: string

  private readonly agent: AcpAgentSpec
  private readonly capabilityServerScript: string
  private readonly drive: AcpDriver

  /**
   * `capabilityServerScript` is REQUIRED, exactly as for codex: the capability
   * surface is injected, and a child process cannot be handed a closure, so the
   * application must supply the entrypoint that serves its own tools over stdio.
   */
  constructor(
    agent: AcpAgentSpec,
    capabilityServerScript: string,
    drive: AcpDriver = defaultAcpDriver,
  ) {
    this.agent = agent
    this.name = agent.name
    this.capabilityServerScript = capabilityServerScript
    this.drive = drive
  }

  supports(spec: RunSpec): EngineSupport {
    const refusal = refusePrivateRun(this.name, spec)
    if (refusal) return refusal
    if (process.env[this.agent.enableEnv] !== "1") {
      return {
        ok: false,
        reason: `${this.name} engine is disabled (set ${this.agent.enableEnv}=1)`,
      }
    }
    if (spec.workflow.runner?.profile !== "ephemeral") {
      return {
        ok: false,
        reason: `${this.name} engine requires the ephemeral runner profile (per-run container isolation)`,
      }
    }
    // A spec that can only read its key from the host env has nothing to run on
    // when the consumer meters credentials itself and turned host fallback off.
    if ((this.agent.hostKeyEnvs?.length ?? 0) > 0 && spec.provider.envFallback === false) {
      return {
        ok: false,
        reason:
          `${this.name} engine reads its key only from the host env ` +
          `(${this.agent.hostKeyEnvs?.join(", ")}), and this run disables host credential fallback`,
      }
    }
    if (this.agent.gatewaySupported === false && spec.gateway) {
      return {
        ok: false,
        reason:
          `${this.name} engine has no gateway route for its provider credentials ` +
          "(no supported provider key is covered by the credential gateway); remove RunSpec.gateway",
      }
    }
    // hostKeyEnvs names the host env keys the spec's env() reads directly.
    // Those reach the harness in the clear, so they count as raw credentials on
    // a vm run just as BYO keys in spec.provider.credentials do.
    return (
      refuseUnisolated(this.name, spec) ??
      refuseBadGateway(this.name, spec) ??
      refuseCredentialsInVm(this.name, spec, this.agent.hostKeyEnvs ?? []) ?? { ok: true }
    )
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    // Emissions land OUTSIDE the sandbox so the bookkeeping file is never captured
    // by the change set; the capability server (an external process) writes here and
    // we read it back after the run.
    const emissionsDir = await mkdtemp(path.join(tmpdir(), "harness-emit-"))
    const emissionsFile = path.join(emissionsDir, "emissions.json")
    const capabilityEnv: Record<string, string> = {
      HARNESS_WORKSPACE_ID: spec.workspaceId,
      HARNESS_WORKDIR: spec.workdir,
      HARNESS_EMISSIONS_FILE: emissionsFile,
    }
    const servers: Record<string, SerializableMcpServer> = {
      ...connectorServers(spec.connectors),
      [CAPABILITY_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [this.capabilityServerScript],
        env: capabilityEnv,
      },
    }

    const options: AcpOptions = {
      command: this.agent.command,
      args: this.agent.args(spec),
      // The capability env also rides on the process env so the stdio capability
      // server inherits it regardless of how the agent forwards `session/new` env.
      //
      // Through a gateway, the agent's own env is built from a spec with NO
      // credentials (so an agent spec that copies keys copies none), every
      // provider is pointed at its gateway route with the run token, and the
      // provider prefixes are no longer inherited from the host.
      env: spec.gateway
        ? {
            ...this.agent.env(withoutCredentials(spec)),
            ...gatewayEnv(spec.gateway),
            ...capabilityEnv,
          }
        : { ...this.agent.env(spec), ...capabilityEnv },
      ...(this.agent.inheritEnvPrefixes
        ? {
            inheritEnvPrefixes: spec.gateway
              ? withoutShadowed(this.agent.inheritEnvPrefixes)
              : this.agent.inheritEnvPrefixes,
          }
        : {}),
      cwd: spec.workdir,
      mcpServers: toAcpMcpServers(servers),
      // ACP's session/new has no system-prompt field, so the environment's
      // system instructions and skills index lead the task prompt; the agent
      // reads the workdir's AGENTS.md (materialized by the caller) itself,
      // unless its spec says it would not find it (`promptAgentsMd`).
      prompt: harnessPrompt(
        spec,
        environmentInstructions(spec, {
          agentsMd: this.agent.promptAgentsMd === true,
          skillsIndex: true,
        }),
      ),
      ...(spec.limits?.maxDurationMs !== undefined
        ? { maxDurationMs: spec.limits.maxDurationMs }
        : {}),
      log: ctx.log,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }

    ctx.log(`${this.name}: driving ACP agent in ${spec.workdir}`)

    const chunks: string[] = []
    let outcome: AcpOutcome
    try {
      outcome = await this.drive(options, {
        onAssistantChunk: (text) => {
          if (text) chunks.push(text)
        },
        onLog: (line) => {
          if (line) ctx.log(`${this.name}: ${truncate(line, LOG_TRUNCATE)}`)
        },
      })
    } catch (err) {
      // A driver that throws on the caller's abort was still canceled, not broken.
      if (!ctx.signal?.aborted) throw err
      outcome = { stopReason: "cancelled", stoppedBy: "signal" }
    }

    if (outcome.stopReason && outcome.stopReason !== "end_turn") {
      ctx.log(`${this.name}: stopped (${outcome.stopReason})`)
    }

    // Report whether the emissions round trip HAPPENED, not what it carried —
    // presence plus size separates "the server never wrote" from "it wrote and the
    // run emitted nothing"; the byte count comes from the file (see codex engine).
    const emissionsStat = await stat(emissionsFile).then(
      (st) => st,
      () => undefined,
    )
    const emissions = await readEmissions(emissionsFile)
    ctx.log(
      `${this.name}: capability emissions — file ${emissionsStat ? `present (${emissionsStat.size} bytes)` : "absent"}` +
        `${emissionsStat && emissions === undefined ? ", unreadable" : ""}`,
    )
    await rm(emissionsDir, { recursive: true, force: true })

    return {
      text: chunks.join("").trim() || "(no output)",
      ...(emissions !== undefined ? { emissions } : {}),
      outcome: acpRunOutcome(outcome),
    }
  }
}

/**
 * Map an ACP turn's ending onto the run outcome vocabulary. Who stopped it
 * wins when the driver knows (`stoppedBy`); otherwise the ACP `stopReason`
 * decides. `max_turn_requests` is the agent's own step budget; `max_tokens`
 * still produced an answer (truncated), so it stays `completed`; a `refusal`
 * did not do the work, so it is `failed`. An agent-side `cancelled` with no
 * known stopper is reported as `canceled`.
 */
export function acpRunOutcome(outcome: AcpOutcome): RunOutcome {
  if (outcome.stoppedBy === "deadline") return "timed_out"
  if (outcome.stoppedBy === "signal") return "canceled"
  switch (outcome.stopReason) {
    case "cancelled":
      return "canceled"
    case "max_turn_requests":
      return "steps_exhausted"
    case "refusal":
      return "failed"
    default:
      return "completed"
  }
}

/**
 * Translate the run's serializable MCP servers into ACP's `McpServer[]`. Same
 * source data every other engine consumes (`connectorServers`), reshaped to the
 * ACP wire form: env and headers become `{ name, value }` arrays.
 */
function toAcpMcpServers(servers: Record<string, SerializableMcpServer>): McpServer[] {
  return Object.entries(servers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      }
    }
    return {
      name,
      type: server.type,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    }
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * The eve agent (Vercel's open-source framework), driven over `eve acp` — its
 * stdio ACP server surface. eve reads its own model/provider from the authored
 * eve application in the workdir; we pass through whatever provider credentials
 * the run carries so a BYO key reaches it. (Open: an eve "agent" is an authored
 * app, so the workdir must contain one — a workflow-declared app path with an
 * `agent/`-root default is the follow-up; today it runs the app at the workdir root.)
 */
export const EVE_AGENT: AcpAgentSpec = {
  name: "eve",
  enableEnv: "RUNNER_ENABLE_EVE",
  command: "eve",
  args: () => ["acp"],
  // Provider settings a BYO key does not cover (a base URL, an org id) and
  // eve's own configuration.
  inheritEnvPrefixes: ["ANTHROPIC_", "OPENAI_", "OPENROUTER_", "EVE_"],
  env: (spec) => {
    const env: Record<string, string> = {}
    const creds = spec.provider.credentials
    if (creds?.anthropic) env.ANTHROPIC_API_KEY = creds.anthropic
    if (creds?.openai) env.OPENAI_API_KEY = creds.openai
    if (creds?.openrouter) env.OPENROUTER_API_KEY = creds.openrouter
    return env
  },
}

/** The spec as an agent sees it through a gateway: its provider with no keys. */
function withoutCredentials(spec: RunSpec): RunSpec {
  const { credentials: _dropped, ...provider } = spec.provider
  return { ...spec, provider }
}

/**
 * OpenCode (`opencode acp`) — an ACP server over stdio that supports 75+
 * providers through the AI SDK and Models.dev. This spec wires the three
 * providers the kernel's credential gateway can route (Anthropic, OpenAI,
 * OpenRouter) as explicit keys; all others require OpenCode's own stored
 * config (see native-only features in the README "Engines → ACP agents").
 *
 * ACP invocation: `opencode acp`
 * Provider keys: ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
 * Docs: https://opencode.ai/docs/acp
 */
/** OpenCode provider ids for the kernel's three routable providers. */
const OPENCODE_PROVIDERS = ["anthropic", "openai", "openrouter"] as const

/**
 * The run's requested model in OpenCode's `provider/model` form, or undefined
 * when the run names none. `opencode acp` takes no `--model` flag; the model is
 * the top-level `model` key of its config, which `OPENCODE_CONFIG_CONTENT`
 * supplies inline as the highest-precedence runtime override
 * (https://opencode.ai/docs/config). OpenCode reads the first `/` segment as
 * its provider id, so the run's provider is resolved FIRST (`provider.preferred`,
 * else the first BYO key in anthropic/openai/openrouter order, the kernel's
 * usual pick) and prefixed unless the model already carries it. That keeps a
 * provider-namespaced id such as OpenRouter's `openai/gpt-4.1` on OpenRouter
 * (`openrouter/openai/gpt-4.1`) instead of letting OpenCode read `openai` as
 * the provider. With no resolvable provider, an already-qualified
 * `<provider>/<model>` passes through for OpenCode's own config to serve, and a
 * bare name is refused: OpenCode would resolve it against its own default
 * provider, a different selection than the caller asked for.
 */
export function opencodeModel(spec: RunSpec): string | undefined {
  const model = spec.provider.model?.trim()
  if (!model) return undefined
  const preferred = spec.provider.preferred?.trim()
  const provider =
    preferred && (OPENCODE_PROVIDERS as readonly string[]).includes(preferred)
      ? preferred
      : OPENCODE_PROVIDERS.find((id) => Boolean(spec.provider.credentials?.[id]))
  if (provider) return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
  if (model.includes("/")) return model
  throw new Error(
    `opencode: cannot honour model "${model}" without a provider — set provider.preferred ` +
      `(anthropic, openai or openrouter), supply that provider's credential, or name the ` +
      `model as "<provider>/<model>"`,
  )
}

/**
 * The host's inline OpenCode config (`OPENCODE_CONFIG_CONTENT`, which the
 * `OPENCODE_` inherit prefix lets through), parsed so a run's model override
 * can be merged INTO it rather than replace it: a runner that supplies
 * provider endpoints or custom providers that way must keep them when a run
 * also names a model. Absent means `{}`. Anything but a JSON object is refused
 * here with a clear message, since OpenCode would reject it at startup anyway.
 */
export function inheritedOpencodeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const raw = env.OPENCODE_CONFIG_CONTENT
  if (!raw || raw.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `opencode: host OPENCODE_CONFIG_CONTENT is not valid JSON (${(err as Error).message})`,
      { cause: err },
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("opencode: host OPENCODE_CONFIG_CONTENT must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

export const OPENCODE_AGENT: AcpAgentSpec = {
  name: "opencode",
  enableEnv: "RUNNER_ENABLE_OPENCODE",
  command: "opencode",
  args: () => ["acp"],
  // OPENCODE_ covers opencode's own configuration env vars.
  // Provider settings (base URLs, org IDs) that a BYO key does not cover ride
  // through as non-credential vars under the provider prefixes.
  inheritEnvPrefixes: ["ANTHROPIC_", "OPENAI_", "OPENROUTER_", "OPENCODE_"],
  // OpenCode takes provider endpoints from `provider.<id>.options.baseURL` in
  // its own config (https://opencode.ai/docs/providers), not from the
  // *_BASE_URL env the gateway sets, so a gateway run would send the run token
  // to the public endpoint. Refused until that config mapping exists.
  gatewaySupported: false,
  env: (spec) => {
    const env: Record<string, string> = {}
    const creds = spec.provider.credentials
    if (creds?.anthropic) env.ANTHROPIC_API_KEY = creds.anthropic
    if (creds?.openai) env.OPENAI_API_KEY = creds.openai
    if (creds?.openrouter) env.OPENROUTER_API_KEY = creds.openrouter
    // The requested model rides on OpenCode's inline config override, merged
    // into whatever inline config the host already supplies (provider
    // endpoints, custom providers), which `childEnv` would otherwise see
    // replaced by this value. The same channel is where gateway routes
    // (`provider.<id>.options.baseURL`) would go once gateway runs are
    // supported.
    const model = opencodeModel(spec)
    if (model) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...inheritedOpencodeConfig(), model })
    return env
  },
}

/**
 * Gemini CLI (`gemini --acp`) — an ACP server over stdio that drives Google's
 * Gemini models. `ProviderSelection.credentials` has no slot for Gemini's
 * provider, so the API key is read from `GEMINI_API_KEY` on the host env.
 * The kernel's credential gateway has no route for Gemini, so gateway-mode
 * runs are refused (`gatewaySupported: false`); see native-only features in
 * the README "Engines → ACP agents".
 *
 * ACP invocation: `gemini --acp`  (note: `--acp` is a flag, not a subcommand)
 * Provider key: GEMINI_API_KEY
 * Docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
 */
export const GEMINI_AGENT: AcpAgentSpec = {
  name: "gemini",
  enableEnv: "RUNNER_ENABLE_GEMINI",
  command: "gemini",
  // `--acp` is a flag on the `gemini` command, not a subcommand. A requested
  // model rides on `--model`, else the CLI's configured default applies.
  args: (spec) => (spec.provider.model ? ["--acp", "--model", spec.provider.model] : ["--acp"]),
  // Gemini CLI discovers `GEMINI.md`, not `AGENTS.md` (reading `AGENTS.md`
  // needs its `context.fileName` setting), so the environment's root and
  // scoped `AGENTS.md` are inlined into the prompt instead.
  promptAgentsMd: true,
  // GEMINI_ covers GEMINI_CLI_HOME and other gemini config vars (non-credential).
  // GOOGLE_ covers Vertex AI config (GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION).
  // GEMINI_API_KEY is passed explicitly in env() below; the *KEY* filter in
  // childEnv would strip it if it arrived through inheritEnvPrefixes.
  inheritEnvPrefixes: ["GEMINI_", "GOOGLE_"],
  // ProviderSelection has no credentials slot for Gemini, so the key comes
  // from the host env. hostKeyEnvs names it so supports() can refuse a vm run
  // that would carry it into the guest unrouted.
  hostKeyEnvs: ["GEMINI_API_KEY"],
  // The kernel's gateway covers anthropic/openai/openrouter only; there is no
  // gateway route for Gemini's provider, so a gateway run would start the
  // agent without its key. Refuse rather than silently fail at auth.
  gatewaySupported: false,
  env: (spec) => {
    const env: Record<string, string> = {}
    // No BYO credentials slot exists for Gemini, so the host key is the only
    // source, and only while the run allows host fallback (supports() refuses
    // a run that turns it off).
    // The key is passed explicitly rather than through inheritEnvPrefixes,
    // which filters credential-looking names (*KEY*, *TOKEN*, *SECRET*).
    const key = process.env.GEMINI_API_KEY
    if (key && spec.provider.envFallback !== false) env.GEMINI_API_KEY = key
    return env
  },
}
