import { describe, it, expect, beforeAll } from "vitest"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NativeEngine } from "./native.js"
import type { Loop, LoopRequest } from "../loop.js"
import type { RunSpec } from "./types.js"

const SECRET = "tok_live_0123456789"

function spec(workdir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "r",
    workspaceId: "w",
    workflowPath: "wf.yml",
    workflow: { name: "Demo", prompt: "Do the thing.", runner: { profile: "ephemeral" } },
    inputs: {},
    context: "",
    workdir,
    permissions: { tools: ["run_code"] },
    secrets: { API_TOKEN: SECRET, REGION: "eu" },
    connectors: [],
    provider: { preferred: "mock" },
    ...overrides,
  }
}

/** A loop that runs one tool call itself and reports what the model would have seen. */
function callingLoop(command: string): { loop: Loop; seen: () => string } {
  let seen = ""
  const loop: Loop = {
    name: "calls-run-code",
    run: async (req, ctx) => {
      const tool = req.tools.find((t) => t.spec.name === "run_code")!
      try {
        seen = await tool.execute(
          { command },
          { signal: ctx.signal ?? new AbortController().signal, callId: "c1" },
        )
      } catch (err) {
        seen = `threw: ${(err as Error).message}`
      }
      return { text: "", steps: 1, outcome: "completed" }
    },
  }
  return { loop, seen: () => seen }
}

describe("NativeEngine secret masking", () => {
  let workdir: string

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "native-mask-"))
  })

  it("masks secret values in what a tool hands back to the model", async () => {
    const { loop, seen } = callingLoop('printf "token=%s" "$API_TOKEN"')
    await new NativeEngine({ loop }).run(spec(workdir), { log: () => {} })

    const out = JSON.parse(seen()) as { stdout: string }
    expect(out.stdout).toBe("token=[secret]")
    expect(seen()).not.toContain(SECRET)
  })

  it("still gives the executed code the real value", async () => {
    // The child compares the value itself; only its verdict crosses back.
    const { loop, seen } = callingLoop(
      `[ "$API_TOKEN" = "${SECRET}" ] && printf ok || printf mismatch`,
    )
    await new NativeEngine({ loop }).run(spec(workdir), { log: () => {} })

    expect((JSON.parse(seen()) as { stdout: string }).stdout).toBe("ok")
  })

  it("masks a multi-line secret in run_code's JSON-encoded result", async () => {
    const key = '-----BEGIN KEY-----\nabc"def\\ghi\n-----END KEY-----'
    const { loop, seen } = callingLoop('printf "%s" "$PRIVATE_KEY"')
    await new NativeEngine({ loop }).run(spec(workdir, { secrets: { PRIVATE_KEY: key } }), {
      log: () => {},
    })

    expect((JSON.parse(seen()) as { stdout: string }).stdout).toBe("[secret]")
    expect(seen()).not.toContain("abc")
  })

  it("leaves values shorter than the minimum alone", async () => {
    const { loop, seen } = callingLoop('printf "%s" "$REGION"')
    await new NativeEngine({ loop }).run(spec(workdir), { log: () => {} })

    expect((JSON.parse(seen()) as { stdout: string }).stdout).toBe("eu")
  })
})

describe("NativeEngine seeded conversation", () => {
  let workdir: string

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "native-seed-"))
  })

  it("seeds the loop with spec.messages verbatim instead of building a task prompt", async () => {
    let seen: LoopRequest | undefined
    const loop: Loop = {
      name: "records",
      run: async (req) => {
        seen = req
        return {
          text: "",
          steps: 1,
          outcome: "suspended",
          stopReason: "suspended",
          messages: [...req.messages, { role: "assistant", text: "", toolCalls: [] }],
          pending: [{ id: "h1", name: "ask_human", input: {} }],
          consumed: { steps: 1, durationMs: 5 },
        }
      },
    }
    const messages: RunSpec["messages"] = [
      { role: "user", text: "earlier" },
      { role: "assistant", text: "", toolCalls: [{ id: "h0", name: "ask_human", input: {} }] },
      { role: "tool", results: [{ toolCallId: "h0", content: "yes" }] },
    ]
    const result = await new NativeEngine({ loop }).run(
      spec(workdir, { messages, limits: { maxSteps: 3, budgetVisible: true } }),
      { log: () => {} },
    )

    expect(seen?.messages).toEqual(messages)
    expect(seen?.limits).toMatchObject({ maxSteps: 3, budgetVisible: true })
    // The system prompt is still built from the spec; only the user prompt is
    // replaced (the workflow's task text rides in the seed's own history).
    expect(seen?.system).toContain("Workflow: Demo")
    // What the loop reported comes back on the engine result, so a caller can store it.
    expect(result.outcome).toBe("suspended")
    expect(result.pending).toEqual([{ id: "h1", name: "ask_human", input: {} }])
    expect(result.consumed).toEqual({ steps: 1, durationMs: 5 })
    expect(result.messages).toHaveLength(4)
  })
})
