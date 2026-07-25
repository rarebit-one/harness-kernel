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
| **Model seam** | `ModelInvocation` — one arrow for every model kind, with declared capabilities, a uniform result envelope and `probe()` |
| **Providers** | `Provider` interface + `selectProvider()` over Anthropic, OpenAI, OpenRouter, and an offline `mock`; `chatModel()` puts any of them on the seam |
| **Agent loop** | `runAgent()` — a provider-neutral tool-use loop with step and wall-clock budgets |
| **Tools** | `Tool`, `primitiveTools()` (`run_code`, `read_file`, `list_files`, `http_fetch`), `connectorTools()`, `modelAsTool()`, metadata + projections |
| **Connectors** | `connectMcp()` — MCP clients over stdio / streamable HTTP / SSE |
| **Engines** | The `AgentEngine` seam + `native`, `claude-code`, and `codex` harnesses, plus the capability *mechanism* (scope guards, a generic `write_file`, and MCP/stdio transports) — the capability *set* is yours to inject |
| **Routing** | `RouteResolver` + `StaticRouteResolver` — capability → model, prompt, tools |
| **Context** | `ContextProvider` chain, assembled in parallel and rendered into the prompt |
| **Secrets** | `secretsToEnv()` — resolved secret values into an exec environment |

## Extension points

The kernel is meant to be extended from outside, never patched from inside.
There are six seams, and each ships with the in-process default that makes it
usable on its own — no database, no service, no infrastructure.

**1. Model kinds.** A chat LLM is one kind among several. Register any other and
resolve it back through the same call:

```ts
import { ModelRegistry, chatModel, selectProvider } from "@rarebit-one/harness-kernel"

const registry = new ModelRegistry()
  .registerInstance(chatModel(selectProvider("anthropic")))
  .register({ kind: "vision.detect", id: "yolo" }, () => myDetector)

const detector = registry.resolve<DetectRequest, DetectionResult>({
  kind: "vision.detect",
  id: "yolo",
})
```

`Req` and `Res` stay typed per kind — the seam unifies the arrow and the
envelope (`ModelResult`, `InvokeContext`, `ModelCaps`, `probe`), never the
payload. An unresolved ref throws rather than returning `undefined`.

**2. Route resolution.** One layer up: which model, prompt and tools serve a
named capability. `StaticRouteResolver` is capabilities-as-code; a dynamic
resolver is your adapter behind the same interface.

```ts
const resolver = new StaticRouteResolver([
  { name: "summarise", model: { kind: "chat", id: "anthropic" }, prompt: "Summarise." },
])
const route = await resolver.resolve("summarise")
const model = registry.resolve(route.model) // the resolver picks, the registry binds
```

**3. Middleware.** Payload-blind, so one implementation covers every kind:

```ts
const model = withMiddleware(anyModel, [correlationMiddleware(), loggingMiddleware()])
```

**4. Engines.** The `AgentEngine` seam — `native`, `claude-code`, `codex`, or
your own. File mutations stay out of band.

**5. Context providers.** Replace a single pre-baked context string with a
chain, so a live source can inject fragments:

```ts
new NativeEngine({ contextProviders: [myLiveFeed] })
```

Providers run in parallel; one that fails is logged and skipped rather than
failing the run.

**6. Tools.** Rich metadata (capability scoping, invocation-mode gating,
confirmation, reversibility, retention, client visibility) with lossy
projections down to what a provider actually needs — and `modelAsTool()`, which
surfaces any model invocation as a callable tool. That last one is the cleanest
form of extension: a perception model becomes something the chat loop can call
without the loop, the engines, or any kernel code learning perception exists.

Capabilities are **checked, not assumed**: asking a model to stream when it
declared `streaming: false` throws a `CapabilityError` instead of quietly
returning a buffered response.

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

const engine = selectEngine("native", { domainTools }) // "claude-code" | "codex" | unknown → native
const support = engine.supports(spec)
if (!support.ok) throw new Error(support.reason) // fail loud, never silently degrade
const { text } = await engine.run(spec, { log: console.error })
```

### The kernel defines no domain tools

`primitiveTools()` is strictly generic — sandboxed shell/file/HTTP access. Tools
that collect **application** output don't exist here at all: what a run may emit
is your vocabulary, so you define it and inject it.

```ts
import { primitiveTools, writeFileCapability, denyCrossWorkspace } from "@rarebit-one/harness-kernel"

// Your sinks, your tools — the kernel never sees them.
const knowledge: MyNote[] = []
const domainTools = (allowed?: string[]) => myEmissionTools({ knowledge }, allowed)

const engine = selectEngine("native", { domainTools })
```

The same holds for the workspace-scoped **capabilities** the external engines
mount over MCP. The kernel ships exactly one — `writeFileCapability`, a sandbox
write with no product semantics — plus the guards (`denyCrossWorkspace`,
`resolveWithin`) so your own capabilities inherit identical security properties:

```ts
selectEngine("claude-code", {
  capabilityTools: (ctx) => [writeFileCapability(ctx), ...myCapabilities(ctx)],
})

// codex runs out-of-process, so it needs a script it can spawn — a child
// process can't be handed a closure. Omitting it throws rather than serving an
// empty surface.
selectEngine("codex", { capabilityServerScript: "/app/dist/my-capability-server.js" })
```

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
