import { resolveLoopLimits } from "../agent.js"
import { assembleContext, renderContext, type ContextProvider } from "../context/types.js"
import { nativeLoop, type Loop } from "../loop.js"
import { asChatModel } from "../models/chat.js"
import { selectProvider } from "../providers/index.js"
import { secretsToEnv } from "../secrets.js"
import { primitiveTools, connectorTools } from "../tools/registry.js"
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

  supports(): EngineSupport {
    return { ok: true }
  }

  async run(spec: RunSpec, ctx: EngineContext): Promise<EngineResult> {
    const provider = selectProvider(spec.provider.preferred, {
      model: spec.provider.model,
      credentials: spec.provider.credentials,
    })
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
    const connectors = await connectorTools(spec.connectors)
    try {
      const tools = [...primitives, ...connectors.tools]
      ctx.log(`tools: ${tools.map((t) => t.spec.name).join(", ") || "(none)"}`)

      // Budgets are resolved before the call: a loop is handed numbers, not
      // optionals, so a second implementation cannot accidentally run to a
      // different ceiling than the one the kernel ships.
      const result = await this.loop.run(
        {
          model: asChatModel(provider),
          system: buildSystemPrompt(spec.workflow, spec.workspaceId, spec.workflowPath),
          userPrompt: buildUserPrompt(
            spec.workflow,
            await this.buildContext(spec, ctx),
            spec.inputs,
          ),
          tools,
          limits: resolveLoopLimits(spec.limits),
        },
        { log: ctx.log, ...(ctx.emit ? { emit: ctx.emit } : {}) },
      )
      return { text: result.text, knowledge: [], issues: [] }
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
