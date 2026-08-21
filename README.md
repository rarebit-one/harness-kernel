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

**v0 — public, published.** `@rarebit-one/harness-kernel` is on npm, MIT
licensed. Install it the ordinary way:

```bash
npm install @rarebit-one/harness-kernel
```

Releases publish from `publish.yml` via npmjs **OIDC trusted publishing** — no
token exists anywhere in this repo. The workflow ships **inert**: the mutating
step is skipped unless the repo variable `PUBLISH_LIVE` is `"true"`, so a
Release cut by accident is a loud no-op. Every version from `0.5.2` on carries a
build provenance attestation.

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
| **Loop** | `Loop` + `nativeLoop` — the control loop as a seam; the kernel ships one and it is the loop `runAgent` has always run |
| **Run events** | `RunEvent` — an ordered, structured account of a run (turns, tool calls, budgets, outcome), emitted to an optional sink |
| **Tools** | `Tool`, `primitiveTools()` (`run_code`, `read_file`, `list_files`, `http_fetch`), `connectorTools()`, `modelAsTool()`, metadata + projections |
| **Connectors** | `connectMcp()` — MCP clients over stdio / streamable HTTP / SSE |
| **Engines** | The `AgentEngine` seam + `native`, `claude-code`, and `codex` harnesses, plus the capability *mechanism* (scope guards, a generic `write_file`, and MCP/stdio transports) — the capability *set* is yours to inject |
| **Routing** | `RouteResolver` + `StaticRouteResolver` — capability → model, prompt, tools |
| **Context** | `ContextProvider` chain, assembled in parallel and rendered into the prompt |
| **Secrets** | `secretsToEnv()` — resolved secret values into an exec environment |

## Extension points

The kernel is meant to be extended from outside, never patched from inside.
There are seven seams, and each ships with the in-process default that makes it
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

**7. The loop.** The control flow itself. Everything above answers "which
implementation?" for something the loop *uses*; this is the loop.

```ts
const confirmFirst: Loop = {
  name: "confirm-first",
  run: async (req, ctx) => {
    const gated = req.tools.filter((t) => t.meta?.requiresConfirmation)
    if (gated.length > 0) return { text: "awaiting confirmation", steps: 0, outcome: "completed" }
    return nativeLoop.run(req, ctx)
  },
}
new NativeEngine({ loop: confirmFirst })
```

A loop is handed **resolved** materials — a bound model, built prompts, a
projected tool surface, budgets as numbers rather than optionals (via
`resolveLoopLimits`, the one place defaults live). It decides control flow and
nothing else, which is what keeps a second implementation small enough to be
worth writing. `runAgent` and `nativeLoop` are the same code path, so they
cannot drift.

Capabilities are **checked, not assumed**: asking a model to stream when it
declared `streaming: false` throws a `CapabilityError` instead of quietly
returning a buffered response.

### Run events

`log` is prose for a human. The event stream is the same run, machine-readable:

```ts
import { runAgent, recordRunEvents } from "@rarebit-one/harness-kernel"

const { sink, events } = recordRunEvents()
await runAgent({ provider, system, userPrompt, tools, emit: sink })
// events: run.started -> model.turn -> tool.called -> tool.succeeded -> ... -> run.finished
```

The **bookends** — `run.started` and `run.finished` — are emitted by
`runWithEvents`, which wraps whichever `Loop` runs. A loop emits only what
happens inside it, so a custom loop that emits nothing still produces a run that
is visibly a run. A guarantee that depends on every future implementor
remembering it is not a guarantee.

On the failure path `steps` and `text` are **omitted**, not zeroed: the loop
threw and never returned a result, so any number there would be invented. The
`model.turn` events already in the stream are the authoritative record of how
far it got.

Engines take the same sink through `EngineContext`:

```ts
await engine.run(spec, { log, emit: sink })
```

Both are **optional** — omit them and the loop behaves exactly as it did before
events existed. Every event carries a monotonic `seq` from a single per-run
counter, so a gap is detectable: a dropped event must never look like an event
that never happened. A sink that throws is reported through `log` and skipped,
never allowed to fail the run.

A sink is an observer and can never be a participant: `tool.called.input` is a
detached copy, so a sink that redacts in place cannot change what the tool
receives. The flip side is a disclosure surface worth knowing about — that field
carries the **raw tool arguments**, so any secret or PII a model passed as an
argument now reaches every attached sink. Nothing outside the model conversation
captured these before; a sink that persists or forwards events should redact.

`run.finished` is always the last event, including when the loop throws — the
error propagates unchanged, but `outcome: "failed"` closes the stream first, so
a crashed run is never mistaken for one still in flight.

**The kernel emits this stream; it does not store it.** Resume, fork, search and
replay all want persistence and a schema — infrastructure a kernel must not
ship. `recordRunEvents()` is an in-memory recorder for tests and the reference
shape for a real store, not a session store itself.

`tool.succeeded` carries the tool's own `reversible` / `undoToolName` /
`undoWindowSeconds` from `ToolMetadata`, copied at call time. That is the
missing half of a bargain the metadata already made: it could declare a tool
undoable but nothing recorded that the tool *ran*, so an application had nothing
concrete to undo. Deciding whether to undo remains policy, and stays in the
application.

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
