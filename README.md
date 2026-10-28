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
new.

## Install

```bash
npm install @rarebit-one/harness-kernel   # once published
```

ESM-only, Node >= 22.

## What's in it

| Area | Exports |
|------|---------|
| **Model seam** | `ModelInvocation` — one arrow for every model kind, with declared capabilities, a uniform result envelope and `probe()` |
| **Providers** | `Provider` interface + `selectProvider()` over Anthropic, OpenAI, OpenRouter, a self-hosted `local` (any OpenAI-compatible server), an offline `mock` (by request) and a `ScriptedProvider` for recorded evals; `chatModel()` puts any of them on the seam; typed per-call `ProviderOptions` (prompt caching, token cap, response format, OpenRouter routing) |
| **Agent loop** | `runConversation()` — a provider-neutral tool-use loop over a seeded conversation, with step and wall-clock budgets, terminal (final-answer) tools, summed usage and the served model in the result; `runAgent()` is its one-prompt form |
| **Loop** | `Loop` + `nativeLoop` — the control loop as a seam; the kernel ships one and it is the loop `runAgent` and `runConversation` have always run |
| **Run events** | `RunEvent` — an ordered, structured account of a run (turns, tool calls, budgets, outcome), emitted to an optional sink |
| **Tools** | `Tool` (+ `ToolContext`), `primitiveTools()` (`run_code`, `read_file`, `list_files`, `http_fetch`), `connectorTools()`, `modelAsTool()`, metadata + projections (`replaySafeTools`, …) |
| **Connectors** | `connectMcp()` — MCP clients over stdio / streamable HTTP / SSE |
| **Engines** | The `AgentEngine` seam + `native`, `claude-code`, `codex`, and ACP (`eve`, `opencode`, `gemini`) harnesses, plus the capability *mechanism* (scope guards, a generic `write_file`, and MCP/stdio transports) — the capability *set* is yours to inject |
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

**4. Engines.** The `AgentEngine` seam — `native`, `claude-code`, `codex`,
ACP agents (`eve`, `opencode`, `gemini`), or your own. File mutations stay out of band.

**5. Context providers.** Replace a single pre-baked context string with a
chain, so a live source can inject fragments:

```ts
new NativeEngine({ contextProviders: [myLiveFeed] })
// or, through the selector:
selectEngine("native", { domainTools, contextProviders: [myLiveFeed] })
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

A model call the loop **absorbs** rather than propagates emits
`model.turn.failed` (with a `phase`). Today that is only the tools-free summary
requested after the step budget runs out: if it fails, the run falls back to the
last assistant prose and still finishes `steps_exhausted`, and the event is what
tells a consumer the final text is not a summary.

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

**Private runs.** Set `RunSpec.private: true` when the run handles material
that must not leave the host. The native engine runs it only on the `local`
provider (`provider.preferred: "local"` with `LOCAL_MODEL_BASE_URL` set) and
refuses it otherwise, with no fallback to ambient cloud keys or the mock. It
also narrows both channels at
the source (`privateRunChannels`): `log` gets no free text, only one
`phase=<event> …` line per event, and every event is marked `redacted: true`
with its model text, tool arguments, error messages and final text withheld (a
tool name the run did not register becomes `(unregistered)`, and tool-call ids
become per-run `call-<n>` surrogates). Structure
survives: types, `seq`, steps, registered tool names, outcomes, budgets, usage
and result byte counts. A thrown error is replaced by a `PrivateRunError` that
carries neither the original message nor a `cause`. The claude-code, codex and
ACP engines refuse a private run in `supports()`. `EngineResult.text` is still
returned to the caller, which decides where it goes.

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

### Cancellation, tool context and usage

Every entry point takes an optional `AbortSignal` — `runAgent({ signal })`,
`engine.run(spec, { log, signal })`, and `LoopContext.signal` for a custom loop:

```ts
const controller = new AbortController()
const result = await engine.run(spec, { log, signal: controller.signal })
// later: controller.abort("user canceled")
result.outcome // "completed" | "steps_exhausted" | "timed_out" | "canceled" | "failed"
```

The native loop merges it with its own wall-clock deadline and threads the
result into every model request (`Provider.converse(req, { signal })`, which the
Anthropic and OpenAI adapters hand to the SDK per request) and every tool call.
So neither a cancel nor the deadline waits for an in-flight step: `run_code`
kills its whole process group, `http_fetch` aborts the request, and MCP calls
send the server a cancellation. An abort is a **clean stop, not a throw** — the
run resolves with the prose it had, `outcome: "canceled"` (the caller's signal)
or `"timed_out"` (the deadline), and no summary call is spent. A model
that ignores the signal and answers anyway has its turn recorded and its prose
kept, but the outcome is still the stop's, and none of the tools it asked for
run; an unrelated error that merely coincides with the stop still propagates.
`EngineResult.outcome` carries the same value; the external engines map their
harness's ending onto it.

Tools receive a second argument, `ToolContext`:

```ts
const tool: Tool = {
  spec,
  meta: { replay: "safe" }, // idempotent: may be re-run after an interruption
  execute: async (input, ctx) => {
    // ctx.signal — stop when the run stops; ctx.callId — the model's call id
    // (matches tool.called.callId); ctx.runId — when the caller supplied one
    return doWork(input, { signal: ctx?.signal, idempotencyKey: ctx?.callId })
  },
}
```

`ToolMetadata.replay` is `"safe"` or `"unsafe"`, and **absent means unsafe**.
It is copied onto `tool.called` / `tool.succeeded`, and `replaySafeTools()`
selects the tools that declared it. The kernel only records the claim; whether
to replay is the application's decision.

Token usage is reported where the provider's API returns it:
`ConverseResult.usage`, `ModelResult.usage` and `model.turn.usage` on the
event stream. A provider opts in with `reportsUsage: true` (the Anthropic and
OpenAI-compatible adapters do), and `chatModel` derives `caps.usage` from it, so
the mock and custom providers never advertise usage they do not deliver. `inputTokens` is all input processed, cached or not (so
`totalTokens = inputTokens + outputTokens`); `cacheReadTokens` /
`cacheWriteTokens` break out the prompt-cache share of it.

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

**`selectProvider` fails loud.** A preferred provider with no credential, or no
preference and no credential at all, throws a `ProviderCredentialsError` naming
the env var and the BYO slot that would have satisfied it; it never falls
through to another configured provider, and a name it does not know (a typo, a
provider with no adapter) is refused the same way rather than read as "no
preference". `providerAvailability()` gives the same
answer as a reason instead of a throw, and `NativeEngine.supports()` uses it, so
a run with no key is refused before a sandbox is prepared. The offline `mock`
is reached only by request (`selectProvider("mock")`) or by explicit opt-in
(`{ allowMockFallback: true }`), which is what a keyless test rig sets. Until
0.11 a keyless run landed on the mock silently and reported success; nothing on
the wire told that run from a real one.

A key passed in `credentials` wins; otherwise each cloud provider falls back to
the host's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`. A
caller that resolves and meters credentials itself sets `{ envFallback: false }`,
so a run it sent no key for fails with `ProviderCredentialsError` instead of
quietly spending whatever key the host process holds. `local` is self-hosted and
keeps its env base URL and key either way. The option governs `selectProvider`
(and so the native engine); vendor-CLI engines take their keys from the child
environment the caller builds.

### Conversations and terminal tools

`runAgent` is single-shot. A conversational application seeds the loop with its
stored history and gets the whole transcript back:

```ts
import { runConversation, terminalTool } from "@rarebit-one/harness-kernel"

const reply = terminalTool({
  name: "reply",
  description: "Send the final answer to the user.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" }, quick_replies: { type: "array", items: { type: "string" } } },
    required: ["text"],
  },
})

const result = await runConversation({
  provider,
  system,
  messages: [...storedHistory, { role: "user", text: incoming }],
  tools: [...lookupTools, reply],
  providerOptions: { promptCache: {} },
})

result.stopReason // "end_turn" | "terminal_tool" | "steps_exhausted" | "timed_out" | "canceled"
result.terminal?.input // { text, quick_replies } when the model called `reply`
result.messages // store this; seed the next turn with it
result.usage // summed over every model call
result.provider, result.model // what actually served the run
```

A tool with `meta.dispatch: "terminal"` is a **final-answer tool**: the loop
still runs its executor (so it can validate, or send), appends the tool result
so the transcript carries no dangling call, and then ends the run with
`stopReason: "terminal_tool"` and the call on `result.terminal`. An executor
that throws turns the call into an ordinary tool error the model gets to
correct. `terminalTool()` builds one with a no-op executor; the structured
answer is the call's `input`, which the kernel does not validate against the
schema (run your own validator on it, or supply an executor that throws).

The seed must end with a user message or with the tool results the model is
waiting for; the loop copies it and never mutates the array it was handed.
`result.events` is this call's event stream (the same events reached `emit`),
recorded for a caller with nowhere else to put them; the kernel still stores
nothing between calls.

**Cut-off answers are never answers.** Every `ConverseResult` carries a
`finishReason` (`stop`, `tool_calls`, `length`, `content_filter`, `unknown`),
mapped from Anthropic's `stop_reason` and the OpenAI dialect's `finish_reason`
and echoed on `model.turn` and `ConversationResult.finishReason`. When a turn
ends with `length`, a terminal call on it is refused even if its arguments
parsed, and so is any call whose raw `argumentsText` does not parse: nothing
runs, the model gets an error result saying so (`tool.failed` with reason
`truncated`), and the loop continues so it can answer again within its budgets.
A cut-off prose answer completes with `stopReason: "length"`, so a consumer can
decline to apply text that is not whole; `runAgent()`, whose bare string could
not say so, throws a `TruncatedAnswerError` (carrying the partial `text` and
the full `result`) in that case instead. `ToolCall.argumentsText` is the exact
bytes the model emitted (the OpenAI dialect keeps and replays them verbatim;
Anthropic hands over an object and leaves it absent), and `ToolCall.meta` is an
opaque per-call bag that rides through history for an adapter that needs it.

`dispatch: "external"` is reserved for a tool the *caller* executes: the loop
would return the pending call and resume when given its result. The native
loop refuses it today (a custom `Loop` may honour it); native suspend/resume is
a later release.

### Provider options and prompt caching

`providerOptions` rides on every model call a run makes and each adapter maps it
onto its own wire format. An option an adapter cannot honour throws a
`ProviderOptionsError` rather than being dropped.

```ts
providerOptions: {
  maxTokens: 1024,                       // per-call completion cap
  temperature: 0.2,
  toolChoice: { name: "reply" },         // "auto" | "required" | "none" | { name }; omitted on a tools-free call
  promptCache: { ttl: "1h" },            // system + tools + last message cached
  responseFormat: { type: "json_object" }, // OpenAI-compatible adapters only
  openrouter: {                          // OpenRouter adapter only
    models: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"], // fallbacks
    provider: { data_collection: "deny", zdr: true },         // data policy
    usage: { include: true },
  },
}
```

`promptCache: {}` means "cache this prompt the usual way". On **Anthropic** that
is a `cache_control` breakpoint on the system prompt, the last tool definition
and the last message (`trailingMessages` up to 2, `ttl` `5m` or `1h`). On
**OpenRouter** the breakpoints go on the system prompt and the trailing
messages as content parts, which the upstreams that cache (Anthropic, Gemini)
honour. On **OpenAI** caching is automatic, so only `promptCache.key` does
anything (it becomes `prompt_cache_key`). The `local` adapter accepts it and
lets the server's own prefix cache do the work.

Every result reports what served it: `ConverseResult.model` is the model id the
response named (with a fallback list it can differ from the one requested),
`responseId` is the provider's own id for the response (a generation id on
OpenRouter), and, behind OpenRouter, `upstream` names who actually processed the
prompt, which is what a zero-data-retention audit needs. `model.turn` events
carry `model`, `responseId` and `upstream` too; `ConversationResult.responseIds`
lists every id in call order and `ConversationResult.upstream` names who served
the last turn, so a cross-vendor fallback chain can still be audited.

The package also exports its own `package.json`
(`import pkg from "@rarebit-one/harness-kernel/package.json" with { type: "json" }`)
so a service can report the kernel version it runs.

Usage carries what the provider prices: beside the token counts, `TokenUsage`
has `cacheWriteTokens`, `reasoningTokens` and `reportedCost`
(`{ amount, currency: "USD" }`, from OpenRouter's `usage.cost`) when the
response reports them, on every `model.turn` event and summed by amount on the
result, so a per-turn cost cap can abort the run through its `signal`. Absent
means unknown, never free.

Two more per-call knobs: `maxRetries` overrides the SDK retry count for one
call (set `0` alongside an OpenRouter `models` chain, or the SDK and the router
both retry), and the `openai` adapter sends the cap as `max_completion_tokens`
(its current field; reasoning models reject `max_tokens`) while OpenRouter and
local servers get `max_tokens`. `connectorTools(..., { toolName })` names MCP
tools your way when the default `<connector>__<tool>` prefix is in the way.

### Recorded evals with `ScriptedProvider`

```ts
import { ScriptedProvider } from "@rarebit-one/harness-kernel"

const provider = new ScriptedProvider([
  { text: "", toolCalls: [{ id: "c1", name: "lookup", input: { q: "balance" } }] },
  (req) => ({ text: "", toolCalls: [{ id: "r1", name: "reply", input: { text: "S$120" } }] }),
])
const result = await runConversation({ provider, system, messages, tools })
provider.requests // every request the loop built, for assertions
provider.remaining // 0 when the whole script was consumed; a longer loop throws
```

It plays a recorded script of model turns in order, records each request it was
given, honours `signal`, and throws `ScriptExhaustedError` rather than invent a
turn, so an eval that drifts from its recording fails instead of passing
quietly.

**Self-hosted (`local`).** `selectProvider("local")` runs against any
OpenAI-compatible server — llama-server, vLLM, LM Studio, Ollama's OpenAI
endpoint — set `LOCAL_MODEL_BASE_URL` (required), and optionally `LOCAL_MODEL`
and `LOCAL_MODEL_API_KEY` (a local server usually needs none; when absent no
`Authorization` header is sent). Unlike the others, `local` **fails loud** when
no base URL is configured rather than degrading to the mock — it is chosen to
keep a run on private inference (e.g. an application that forces sensitive-data
runs onto a designated model), so silently running it elsewhere
would defeat the point.

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

The out-of-process engines (`claude-code`, `codex`, ACP) hand the run to a
harness that has its own shell and approves its own actions, so the box it runs
in is the only boundary. Each refuses in `supports()` unless it is enabled
(`RUNNER_ENABLE_<ENGINE>=1`), the workflow asks for the `ephemeral` profile,
**and** the run has at least `container` isolation. Two parties must assert
that last condition, and the weaker claim wins:

- the caller, through `RunSpec.isolation` (`none` | `container` | `vm`), stating
  what it placed the run on;
- the host process, through `RUNNER_ISOLATION`, set by its own entrypoint and
  never taken from a payload.

The harness's child process gets an allowlisted environment rather than the
host's whole one: `PATH`, `HOME`, locale, temp, CA and proxy variables, plus
that harness's own prefixes (`ANTHROPIC_`/`CLAUDE_` for claude-code,
`OPENAI_`/`CODEX_` for codex, and `AcpAgentSpec.inheritEnvPrefixes` for an ACP
agent). A prefix match never passes a credential-looking name (`*KEY*`,
`*TOKEN*`, `*SECRET*`, …). The one provider key an engine needs is passed
explicitly instead: claude-code and codex take the run's BYO key, falling back
to the host's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; an ACP agent gets only
the run's keys. Every other host credential stays with the host. That filter is
best effort, so keep `inheritEnvPrefixes` narrow. The proxy variables pass
unfiltered, so a proxy URL with embedded credentials is visible to the harness.

Behaviour that follows from this, since 0.10.0:

- Claude Code on Bedrock or Vertex (`AWS_*`, `GOOGLE_*`) is not reachable
  through these engines.
- Claude Code subscription auth (`CLAUDE_CODE_OAUTH_TOKEN`) is not passed; use
  an API key.
- An ACP agent no longer falls back to the host's provider keys.

#### ACP agents: native-only features

The ACP protocol carries MCP servers and a prompt; it does not carry every
feature of the underlying CLI. Use the spec objects directly with `new
AcpEngine(spec, capabilityServerScript)` for custom configuration.

**`eve` (`eve acp`)** — BYO Anthropic / OpenAI / OpenRouter keys from
`spec.provider.credentials`; all three have gateway routes. Interactive modes
and `EVE_*` config are native-only.

**`opencode` (`opencode acp`)** — BYO Anthropic / OpenAI / OpenRouter keys from
`spec.provider.credentials`. `spec.provider.model` is passed as OpenCode's
`model` (`provider/model`) through the `OPENCODE_CONFIG_CONTENT` inline config
override, merged into any inline config (JSON or JSONC) the host already supplies there. The run's provider (`provider.preferred`, else the first BYO key) is
prefixed unless the model already carries it, so OpenRouter's namespaced
`openai/gpt-4.1` stays `openrouter/openai/gpt-4.1`; a bare model name with no
resolvable provider is refused. Gateway runs are
refused for now: OpenCode takes
provider endpoints from `provider.<id>.options.baseURL` in its own config, not
from the `*_BASE_URL` env the gateway sets, so a gateway run would send the run
token to the public endpoint. The remaining 70+
providers OpenCode supports (Vertex AI, AWS Bedrock, GitHub Copilot, Snowflake,
…) require OpenCode's own stored config (`~/.opencode/` or `OPENCODE_HOME`) and
are native-only: there is no BYO credentials slot for them in `ProviderSelection`
and no gateway route. The interactive TUI is also native-only.

**`gemini` (`gemini --acp`)** — API-key auth only (`GEMINI_API_KEY` from the
host env; there is no `ProviderSelection.credentials` slot for Gemini).
`spec.provider.model` is passed as `--model`. Gemini CLI discovers `GEMINI.md`,
not `AGENTS.md`, so the environment's root and scoped `AGENTS.md` are inlined
into the prompt's instructions (as the Claude Code engine appends them) rather
than relying on its `context.fileName` setting. The
following authentication methods are **native-only** and cannot be used through
this engine:

- **Vertex AI** (`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`, or
  `GOOGLE_API_KEY` in express mode) — the `GOOGLE_` inherit prefix passes those
  vars through for non-gateway runs, but Vertex auth requires the CLI to perform
  an ADC exchange that ACP mode may not complete without a terminal.
- **OAuth / Login with Google** — interactive only.

The kernel's credential gateway has **no route** for Gemini's provider
(`GEMINI_API_KEY`). `supports()` refuses any run that carries `RunSpec.gateway`,
rather than starting Gemini without credentials. Use a non-gateway run and set
`GEMINI_API_KEY` on the runner host. Because that key belongs to the host, not
the run, a run with `provider.envFallback: false` (a consumer that meters keys
per layer) is refused too, and the key is never passed to it.

### Run environment

A `RunSpec` may carry an environment that every engine starts from:
`instructions` (`system`, `agentsMd`), `agentFiles` (nested `AGENTS.md`),
`skills` (Agent Skills directories) and `sources` (inline input files). Every
field is optional; a spec with none of them runs exactly as before.

The work is split in two. The **caller** puts the workdir half on disk, because
it owns the tree's lifecycle: it writes before setup and restores before
diffing, so none of it reaches the change set.

```ts
import { materializeEnvironment } from "@rarebit-one/harness-kernel"

const env = await materializeEnvironment(spec) // AGENTS.md, .agents/skills/<name>/, sources
try {
  await runSetup()
  await engine.run(spec, ctx)
} finally {
  await env.restore() // merged files back, created files gone; harness edits kept and reported
}
```

Each **engine** compiles the rest into its own harness:

| Engine | `instructions.system` | `instructions.agentsMd` | `skills` |
|---|---|---|---|
| native | system prompt | system prompt | index in the system prompt; files on disk |
| claude-code | `systemPrompt` preset + `append` | `append` (Claude Code does not read `AGENTS.md`) | local plugin in a temp dir |
| codex | `$CODEX_HOME/AGENTS.md` | the workdir `AGENTS.md` | index in `$CODEX_HOME/AGENTS.md` |
| ACP | top of the prompt | the workdir `AGENTS.md` | index at the top of the prompt |

With an environment, claude-code also loads `settingSources: ["project"]` only,
so the workspace's `CLAUDE.md` and `.claude/` apply but the host's user
settings do not. `src/engines/__goldens__/conformance/` pins each engine's
compiled output for one spec.

### Credential gateway

`RunSpec.gateway` (`{ baseUrl, runToken, routes? }`) points a run's model calls
at a host-side gateway that holds the real keys. Every engine sends to
`routes[provider] ?? <baseUrl>/p/<provider>` with the run token as its key:

- native builds its adapters with that base URL (`ProviderSelection.baseURLs`);
- claude-code, codex and ACP agents get `<PROVIDER>_BASE_URL` plus the token in
  place of `<PROVIDER>_API_KEY` (and `CODEX_API_KEY` for codex).

Through a gateway, no raw credential reaches a harness: the run's BYO keys and
the host's env keys are both dropped, and the host's `ANTHROPIC_*`, `OPENAI_*`
and `OPENROUTER_*` settings are not inherited, so nothing can route around it.
A malformed gateway fails `supports()` rather than being ignored.

Independently of the gateway, every engine refuses a run whose `isolation` is
`vm` when it holds raw model credentials (a `provider.credentials` slot, or the
host key that engine would fall back to). A microVM run reaches models through a
gateway or not at all. The private (local-inference) native path gets the same
checks.

A `vm` run is also refused when it holds **exposed** credentials, which no
gateway can inject and which therefore reach the guest in the clear: non-empty
`secrets`, or a connector credential the harness carries itself (`auth.token`,
or `headers` / `env` values on a caller's connector shape). A connector whose
token is the gateway's run token is routed, not exposed. The caller's policy can
lift this with `RunSpec.exposedCredentials: "allowed"`; absent, it refuses.
Below `vm` nothing changes.

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
