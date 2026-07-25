import { runAgent } from "../agent.js"
import { selectProvider } from "../providers/index.js"
import { secretsToEnv } from "../secrets.js"
import { primitiveTools, connectorTools, emissionTools } from "../tools/registry.js"
import type { EmissionSinks, Tool } from "../tools/registry.js"
import type { IssueEntry, KnowledgeEntry, WorkflowDefinition } from "../types.js"
import type { AgentEngine, EngineContext, EngineResult, EngineSupport, RunSpec } from "./types.js"

/**
 * Builds the non-generic tools a run gets on top of the primitives, bound to
 * the run's emission sinks and gated by the same permissions allowlist.
 */
export type DomainToolFactory = (sinks: EmissionSinks, allowed?: string[]) => Tool[]

export interface NativeEngineOptions {
  /**
   * Application tools composed in alongside the generic primitives. Defaults to
   * the kernel's {@link emissionTools} (promote_knowledge + record_issue), which
   * is what fills {@link EngineResult.knowledge} / `.issues`. Pass your own to
   * swap or extend that surface without subclassing the engine.
   */
  domainTools?: DomainToolFactory
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

  constructor(options: NativeEngineOptions = {}) {
    this.domainTools = options.domainTools ?? emissionTools
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
    // Collects knowledge the agent records via the `promote_knowledge` tool;
    // folded into the result for the caller to route onward.
    const knowledge: KnowledgeEntry[] = []
    // Collects issues the agent opens via the `record_issue` tool; folded into
    // the result for the caller to route onward.
    const issues: IssueEntry[] = []
    // Generic primitives + the application's own domain tools, both gated by the
    // run's permissions allowlist.
    const primitives = [
      ...primitiveTools(spec.workdir, env, allowed, allowHosts),
      ...this.domainTools({ knowledge, issues }, allowed),
    ]
    // Connector tools are NOT re-gated by permissions.tools: the caller
    // already authorized them per connector (scope + grants) when it populated
    // connectors, and their names are namespaced `<connector>__<tool>`.
    const connectors = await connectorTools(spec.connectors)
    try {
      const tools = [...primitives, ...connectors.tools]
      ctx.log(`tools: ${tools.map((t) => t.spec.name).join(", ") || "(none)"}`)

      const text = await runAgent({
        provider,
        system: buildSystemPrompt(spec.workflow, spec.workspaceId, spec.workflowPath),
        userPrompt: buildUserPrompt(spec.workflow, spec.context, spec.inputs),
        tools,
        log: ctx.log,
        ...(spec.limits?.maxSteps !== undefined ? { maxSteps: spec.limits.maxSteps } : {}),
        ...(spec.limits?.maxDurationMs !== undefined
          ? { maxDurationMs: spec.limits.maxDurationMs }
          : {}),
      })
      return { text, knowledge, issues }
    } finally {
      // Connectors are only needed during the loop; close them here (the engine
      // opened them) regardless of how run() exits.
      await connectors.close()
    }
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
