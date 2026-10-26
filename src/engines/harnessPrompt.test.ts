import { describe, it, expect } from "vitest"
import { harnessPrompt } from "./harnessPrompt.js"
import type { RunSpec } from "./types.js"

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing." },
    inputs: { foo: 1 },
    context: "",
    workdir: "/sandbox/x",
    permissions: {},
    secrets: {},
    connectors: [],
    provider: {},
    ...overrides,
  }
}

describe("harnessPrompt", () => {
  it("is unchanged from the pre-context prompt when the run has no context", () => {
    // Pinned verbatim: a run without context must get exactly the prompt it
    // always had.
    expect(harnessPrompt(spec())).toBe(
      [
        "Do the thing.",
        "",
        "## Inputs",
        "```json",
        '{\n  "foo": 1\n}',
        "```",
        "",
        "You are running as an autonomous workflow. The current working directory is the",
        "workspace — inspect and edit its files directly with your tools. When finished,",
        "reply with the workflow's output as Markdown.",
      ].join("\n"),
    )
  })

  it("treats whitespace-only context as no context", () => {
    expect(harnessPrompt(spec({ context: "  \n\t" }))).toBe(harnessPrompt(spec()))
  })

  it("includes the run's context between the inputs and the closing instruction", () => {
    const prompt = harnessPrompt(spec({ context: "### notes.md\nThe deadline is Friday." }))
    expect(prompt).toContain("## Workspace context\n### notes.md\nThe deadline is Friday.\n")
    expect(prompt.indexOf("## Inputs")).toBeLessThan(prompt.indexOf("## Workspace context"))
    expect(prompt.indexOf("## Workspace context")).toBeLessThan(
      prompt.indexOf("You are running as an autonomous workflow."),
    )
  })

  it("falls back to naming the workflow when it has no prompt", () => {
    expect(harnessPrompt(spec({ workflow: { name: "Demo" } }))).toMatch(
      /^Execute the "Demo" workflow\./,
    )
  })
})
