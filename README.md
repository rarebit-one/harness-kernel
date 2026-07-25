# harness-kernel

A **provider-neutral AI-harness kernel** in TypeScript: LLM adapters, a tool-use
loop, MCP connectors, sandbox primitives, and a pluggable agent-engine seam.

It is deliberately a *kernel*, not a framework. It holds the commodity mechanics
every AI harness needs and nothing else — applications are the userland. The
kernel never knows an application exists; dependencies point **one way only**
(`app layer → kernel`, never the reverse).

```
                    harness-kernel
             ▲            ▲            ▲
      app harness   app harness   app harness      (one-way deps)
```

## Status

**v0 — private, unpublished.** The package is built OSS-ready (MIT licensed, npm
OIDC trusted-publishing workflow wired) but the repo is private and nothing has
been published to npm. `publish.yml` fires only on a GitHub Release, and no
Release exists, so the publish path is dormant until the public flip.

v0 is a mechanical extraction of a proven, already-provider-neutral agent core
into a standalone package — the mechanics are battle-tested, the packaging is
new. Seam-widening (a general `ModelInvocation` seam, streaming, multimodal
input, middleware, context providers) is planned as an additive v0.2.

## Install

```bash
npm install @rarebit-one/harness-kernel   # once published
```

ESM-only, Node >= 22.

## What's in it

| Area | Exports |
|------|---------|
| **Providers** | `Provider` interface + `selectProvider()` over Anthropic, OpenAI, OpenRouter, and an offline `mock` |
| **Agent loop** | `runAgent()` — a provider-neutral tool-use loop with step and wall-clock budgets |
| **Tools** | `Tool`, `primitiveTools()` (`run_code`, `read_file`, `list_files`, `http_fetch`), `connectorTools()` |
| **Connectors** | `connectMcp()` — MCP clients over stdio / streamable HTTP / SSE |
| **Engines** | The `AgentEngine` seam + `native`, `claude-code`, and `codex` harnesses, plus the shared capability surface |
| **Secrets** | `secretsToEnv()` — resolved secret values into an exec environment |

## Usage

```ts
import { selectProvider, runAgent, primitiveTools } from "@rarebit-one/harness-kernel"

const provider = selectProvider("anthropic", { model: "claude-sonnet-5" })

const text = await runAgent({
  provider,
  system: "You are a helpful autonomous agent.",
  userPrompt: "Summarise the repo's README.",
  tools: primitiveTools("/path/to/sandbox", process.env),
})
```

With no provider API key configured, `selectProvider` falls back to the offline
`mock` provider — so the whole loop runs end to end with no keys and no network.
That is deliberate: the test suite depends on it, and so can yours.

### Engines

An engine is a pluggable agent harness. `native` is the in-process tool-use loop
above; `claude-code` and `codex` shell out to those CLIs/SDKs. All three share
one capability surface (`open_issue`, `write_file`, `promote_knowledge`) scoped
to a single run's workspace, and all three mutate files **out of band** — the
caller diffs the working tree afterwards, so the engine contract never has to
model "an edit" uniformly.

```ts
import { selectEngine } from "@rarebit-one/harness-kernel"

const engine = selectEngine("native") // "claude-code" | "codex" | unknown → native
const support = engine.supports(spec)
if (!support.ok) throw new Error(support.reason) // fail loud, never silently degrade
const { text, knowledge, issues } = await engine.run(spec, { log: console.error })
```

### Generic vs. domain tools

`primitiveTools()` is strictly generic — sandboxed shell/file/HTTP access.
The two **emission** tools (`promote_knowledge`, `record_issue`) that collect
application-domain output are a separate, injectable factory, `emissionTools()`,
so an application composes them in rather than inheriting them:

```ts
import { primitiveTools, emissionTools } from "@rarebit-one/harness-kernel"

const knowledge = []
const issues = []
const tools = [
  ...primitiveTools(workdir, env, allowed, allowHosts),
  ...emissionTools({ knowledge, issues }, allowed),
]
```

`NativeEngine` composes exactly this pair by default, and accepts a replacement
factory via `new NativeEngine({ domainTools })`.

## Development

```bash
npm ci
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .   (lint:fix to autofix)
npm run format         # prettier --write .   (format:check to verify)
npm test               # vitest run
npm run build          # tsc -p tsconfig.build.json → dist/ + .d.ts
```

## License

MIT © Rarebit One
