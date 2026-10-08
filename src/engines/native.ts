import { resolveLoopLimits } from "../agent.js"
import { assembleContext, renderContext, type ContextProvider } from "../context/types.js"
import { runEventEmitter } from "../events.js"
import { nativeLoop, runWithEvents, type Loop } from "../loop.js"
import { asChatModel } from "../models/chat.js"
import { selectProvider } from "../providers/index.js"
import { secretsToEnv } from "../secrets.js"
import { primitiveTools, connectorTools } from "../tools/registry.js"
import { PrivateRunError, privateRunChannels } from "../private.js"
import type { Tool } from "../tools/registry.js"
import type { WorkflowDefinition } from "../types.js"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"

/**
 * Builds the non-generic tools a run gets on top of the primitives, gated by the
 * same permissions allowlist. An application closes over whatever sinks it wants
 * the results to land in — the kernel neither supplies nor inspects them.
 */
export type DomainToolFactory = (allowed?: string[]) => Tool[]

export interface NativeEngineOptions {
  /**
   * Application tools composed in alongside the generic primitives. Defaults to
   * none: the kernel ships no domain tools, because what a run may emit is the
   * application's vocabulary. Pass a factory to add them.
   */
  domainTools?: DomainToolFactory
  /**
   * Extra context sources asked for fragments at run time, appended after the
   * spec's own pre-assembled `context`. Absent (the default) means the prompt is
   * built from `spec.context` alone, exactly as before this seam existed.
   */
  contextProviders?: ContextProvider[]
  /**
   * The control loop that drives the run. Defaults to `nativeLoop` — the loop
   * this engine has always run — so an engine constructed without one is
   * unchanged. Pass your own to change control flow (a confirmation gate, a
   * plan-then-execute shape) without forking the engine or the loop.
   */
  loop?: Loop
}

/**
 * The in-process native engine: the provider-neutral tool-use loop over the
 * general-purpose primitives (run_code, read_file, list_files, http_fetch) plus
 * the run's domain tools and MCP connectors. This is the default engine and the
 * only one safe to run on a warm shared host — the primitives are the isolation
 * boundary.
 */
export class NativeEngine implements AgentEngine {
  readonly name = "native"

  private readonly domainTools: DomainToolFactory
  private readonly contextProviders: ContextProvider[]
  private readonly loop: Loop

  constructor(options: NativeEngineOptions = {}) {
    this.domainTools = options.domainTools ?? (() => [])
    this.contextProviders = options.contextProviders ?? []
    this.loop = options.loop ?? nativeLoop
  }

  /**
   * A private run must stay on local inference, and that is a guarantee, not a
   * preference: it is refused unless the run names the `local` provider AND the
   * host has one configured. There is no fallback to a cloud provider found in
   * ambient credentials, and none to the offline mock either — a private run
   * that silently ran somewhere else, or not at all, would look like it worked.
   */
  supports(spec?: RunSpec): EngineSupport {
    if (spec?.private) return privateProviderSupport(spec)
    return { ok: true }
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    if (!spec.private) return this.runWith(spec, ctx)

    // Checked again here, not only in `supports()`: a caller that skips the
    // capability check must still never reach a non-local provider. The reason
    // names configuration only, never the run's material.
    const support = privateProviderSupport(spec)
    if (!support.ok) throw new Error(support.reason)

    // A private run's material must not reach the caller's log or event sink.
    // Narrowing the channels here, rather than inside the loop, covers every
    // writer at once: the loop (including an injected one), context providers,
    // connector setup and this engine's own lines.
    const channels = privateRunChannels(ctx.log, ctx.emit)
    let loopStarted = false
    try {
      return await this.runWith(spec, {
        ...ctx,
        log: channels.log,
        emit: (event) => {
          if (event.type === "run.started") loopStarted = true
          channels.emit(event)
        },
      })
    } catch {
      // The original error can quote the material (a tool's error, a provider
      // echoing the prompt), so none of it — message or cause — goes back.
      throw new PrivateRunError(loopStarted ? "loop" : "setup")
    }
  }

  private async runWith(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    // Setup (connecting MCP servers, assembling context) happens before the
    // loop sees the signal, and either can stall. So a cancel is honoured here
    // too: an already-canceled run does no setup at all, and a cancel during a
    // stalled setup step returns at once instead of waiting it out. Such a run
    // never started its loop, so it emits no events.
    if (ctx.signal?.aborted) return canceledBeforeLoop(ctx)

    const provider = selectProvider(spec.provider.preferred, {
      model: spec.provider.model,
      credentials: spec.provider.credentials,
    })
    // Belt and braces for the private path: whatever selection did, a private
    // run proceeds on the local provider or not at all.
    if (spec.private && provider.name !== "local") {
      throw new Error(`private run resolved to provider "${provider.name}", not "local"`)
    }
    ctx.log(`provider: ${provider.name}`)

    // General-purpose primitives (secrets injected as env) + the run's connectors.
    const env = secretsToEnv(spec.secrets)
    const allowed = Array.isArray(spec.permissions.tools) ? spec.permissions.tools : undefined
    const allowHosts = Array.isArray(spec.permissions.hosts) ? spec.permissions.hosts : undefined
    // Generic primitives + the application's own domain tools, both gated by the
    // run's permissions allowlist. Anything the domain tools collect goes to
    // sinks the application owns; the kernel never sees them.
    const primitives = [
      ...primitiveTools(spec.workdir, env, allowed, allowHosts),
      ...this.domainTools(allowed),
    ]
    // Connector tools are NOT re-gated by permissions.tools: the caller
    // already authorized them per connector (scope + grants) when it populated
    // connectors, and their names are namespaced `<connector>__<tool>`.
    // The signal reaches `connectorTools`, which closes whatever it had
    // already opened when a cancel lands mid-setup.
    let connectors: Awaited<ReturnType<typeof connectorTools>>
    try {
      connectors = await connectorTools(spec.connectors, undefined, { signal: ctx.signal })
    } catch (err) {
      if (!ctx.signal?.aborted) throw err
      return canceledBeforeLoop(ctx)
    }
    try {
      const tools = [...primitives, ...connectors.tools]
      ctx.log(`tools: ${tools.map((t) => t.spec.name).join(", ") || "(none)"}`)

      // Budgets are resolved before the call: a loop is handed numbers, not
      // optionals, so a second implementation cannot accidentally run to a
      // different ceiling than the one the kernel ships.
      let context: string
      try {
        context = await untilAborted(this.buildContext(spec, ctx), ctx.signal)
      } catch (err) {
        if (!ctx.signal?.aborted) throw err
        return canceledBeforeLoop(ctx)
      }
      const result = await runWithEvents(
        this.loop,
        {
          model: asChatModel(provider),
          system: buildSystemPrompt(spec.workflow, spec.workspaceId, spec.workflowPath),
          userPrompt: buildUserPrompt(spec.workflow, context, spec.inputs),
          tools,
          limits: resolveLoopLimits(spec.limits),
        },
        // The bookends come from `runWithEvents`, so an application's own loop
        // gets them without having to know they exist.
        {
          log: ctx.log,
          events: runEventEmitter(ctx.emit, ctx.log),
          runId: spec.runId,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      )
      return { text: result.text, outcome: result.outcome }
    } finally {
      // Connectors are only needed during the loop; close them here (the engine
      // opened them) regardless of how run() exits.
      await connectors.close()
    }
  }

  /**
   * The run's context text: the spec's own pre-assembled context, then whatever
   * the configured providers contribute. With no providers this returns
   * `spec.context` unchanged, so the prompt is byte-identical to a run that
   * predates the seam.
   */
  private async buildContext(spec: RunSpec, ctx: EngineContext): Promise<string> {
    if (this.contextProviders.length === 0) return spec.context

    const fragments = await assembleContext(this.contextProviders, spec, ctx.log)
    if (fragments.length === 0) return spec.context

    ctx.log(
      `context: ${fragments.length} fragment(s) from ${this.contextProviders.length} provider(s)`,
    )
    const assembled = renderContext(fragments)
    return spec.context ? `${spec.context}\n\n${assembled}` : assembled
  }
}

/**
 * Whether a private run can be held to local inference on this host. Only an
 * explicit `preferred: "local"` with `LOCAL_MODEL_BASE_URL` set qualifies; every
 * other preference — including none, which would fall through to ambient cloud
 * keys or the mock — is refused.
 */
function privateProviderSupport(spec: RunSpec): EngineSupport {
  if (spec.provider.preferred !== "local") {
    return {
      ok: false,
      reason:
        `a private run requires provider.preferred "local" (got ` +
        `${spec.provider.preferred ? `"${spec.provider.preferred}"` : "none"}); ` +
        "it is never routed to another provider",
    }
  }
  if (!process.env.LOCAL_MODEL_BASE_URL) {
    return {
      ok: false,
      reason: "a private run requires the local provider, but LOCAL_MODEL_BASE_URL is not set",
    }
  }
  return { ok: true }
}

/** The result of a run canceled before its loop started: nothing ran. */
function canceledBeforeLoop(ctx: EngineContext): EngineResult {
  ctx.log("native: canceled before the loop started")
  return {
    text: "(no output)\n\n[run stopped: canceled before the run started]",
    outcome: "canceled",
  }
}

/**
 * Await `work`, but stop waiting (rejecting with the signal's reason) the
 * moment `signal` aborts. The work itself is not interrupted — the caller
 * cleans up whatever it eventually produces.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error)
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function buildSystemPrompt(
  workflow: WorkflowDefinition,
  workspaceId: string,
  workflowPath: string,
): string {
  return [
    "You are an autonomous workflow executing in an isolated workspace sandbox.",
    `Workspace: ${workspaceId}`,
    `Workflow: ${workflow.name ?? workflowPath}`,
    "Use the provided tools to inspect the workspace, run the repo's own code, and",
    "call connectors as needed. Delegate anything that must be precise or",
    "reproducible (calculations, dates, side effects) to code via run_code rather",
    "than doing it yourself. When finished, reply with the workflow's output as",
    "Markdown and no further tool calls.",
  ].join("\n")
}

function buildUserPrompt(
  workflow: WorkflowDefinition,
  context: string,
  inputs: Record<string, unknown>,
): string {
  const inputsJson = JSON.stringify(inputs ?? {}, null, 2)
  return [
    workflow.prompt ?? `Execute the "${workflow.name}" workflow.`,
    "",
    "## Inputs",
    "```json",
    inputsJson,
    "```",
    "",
    "## Workspace context",
    context || "(no context files matched)",
  ].join("\n")
}
