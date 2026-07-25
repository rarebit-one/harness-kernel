import type { CompletionRequest, ConverseRequest, ConverseResult, Provider } from "./types.js"
import type { ProviderSelection } from "./index.js"

/**
 * Deterministic, offline provider. Used when no API key is configured — or when a
 * workflow explicitly asks for `preferred: mock` — so the end-to-end loop (and
 * tests) run without network access or credentials.
 *
 * It cannot call a model, but it is handed the SAME provider selection a real
 * provider would receive (the resolved per-run model + per-org BYO keys) and
 * self-documents what a real run WOULD have used. That makes model/key
 * resolution OBSERVABLE offline — a caller's e2e harness can read it back out of
 * the run's output artifact to assert key precedence. It never echoes a key,
 * only its last-4 marker.
 */
export class MockProvider implements Provider {
  readonly name = "mock"
  private readonly selection: ProviderSelection

  constructor(selection: ProviderSelection = {}) {
    this.selection = selection
  }

  // "What a real provider would have used" for the model: the model the caller
  // resolved (workflow YAML → org default), else the host's
  // env-default model (the SAME env vars the real providers read), else
  // the provider's built-in default. `source` labels which rung of that fallback
  // won, so the offline observer can tell the org-default case from the env case.
  private resolvedModel(): { value: string; source: string } {
    if (this.selection.model) return { value: this.selection.model, source: "resolved" }
    const envModel =
      process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL
    if (envModel) return { value: envModel, source: "runner env default" }
    return { value: "(provider built-in default)", source: "provider built-in default" }
  }

  // Which per-org BYO key WOULD have been threaded, by masked last-4 ONLY — never
  // the key itself. `(none …)` means the org set no key for that provider, so the
  // runner's own env key would be used.
  private byoKeyMarker(): string {
    const creds = this.selection.credentials ?? {}
    const present = (["anthropic", "openai", "openrouter"] as const)
      .filter((p) => creds[p])
      .map((p) => `${p}:…${creds[p]!.slice(-4)}`)
    return present.length ? present.join(", ") : "(none — runner env key would be used)"
  }

  // The block the e2e harness parses out of output.md. Deterministic and offline.
  private selectionLines(): string[] {
    const model = this.resolvedModel()
    return [
      "## Provider selection (mock — dry run)",
      "",
      `model: ${model.value} (${model.source}; would be used)`,
      `org BYO key: ${this.byoKeyMarker()}`,
      "",
    ]
  }

  complete(req: CompletionRequest): Promise<string> {
    const preview = req.prompt.slice(0, 600)
    return Promise.resolve(
      [
        "# Workflow Output (mock provider)",
        "",
        "_Generated offline by the harness-kernel mock provider. Set ANTHROPIC_API_KEY",
        "or OPENAI_API_KEY to use a real model._",
        "",
        ...this.selectionLines(),
        "## System",
        "",
        req.system,
        "",
        "## Context + Inputs (excerpt)",
        "",
        "```",
        preview,
        "```",
      ].join("\n"),
    )
  }

  // The mock never calls tools, so the agent loop terminates after one turn. It
  // echoes which tools were available, which is handy when running offline.
  async converse(req: ConverseRequest): Promise<ConverseResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")
    const prompt = lastUser && lastUser.role === "user" ? lastUser.text : ""
    const text = await this.complete({
      system: `${req.system}\n\nAvailable tools: ${req.tools.map((t) => t.name).join(", ") || "(none)"}`,
      prompt,
    })
    return { text, toolCalls: [] }
  }
}
