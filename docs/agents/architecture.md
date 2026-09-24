# Architecture: source layout and the seven extension points

Moved verbatim from the former `CLAUDE.md`; `AGENTS.md` routes here.

## Origin

v0 is a mechanical extraction of a proven, already-decoupled agent core into a
standalone package. The mechanics carry years of production behaviour with them;
what is new is the packaging, the public API, and the brand-neutrality. The
first consumer will be migrated onto this package rather than the other way
around — the kernel never bends to a consumer.

## Layout

| Path | What it is |
|------|------------|
| `src/index.ts` | The public API. Anything not re-exported here is internal. |
| `src/types.ts` | The three shared shapes callers hand in: `ConnectorConfig`, `Permissions`, `WorkflowDefinition`. What a run EMITS is not here — it is opaque, see `EngineResult.emissions`. |
| `src/models/` | The `ModelInvocation` seam (`types.ts`), the `chat` kind + `Provider` adapter (`chat.ts`), the kind registry (`registry.ts`), middleware (`middleware.ts`) |
| `src/routing/` | `RouteResolver` + the built-in `StaticRouteResolver` (capabilities as code) |
| `src/context/` | `ContextProvider` chain — `assembleContext` / `renderContext` |
| `src/providers/` | `Provider` interface + anthropic / openai / openrouter / mock adapters, `selectProvider` |
| `src/agent.ts` | `runNativeLoop` — the tool-use loop; `runAgent` is the option-bag adapter onto it, and `resolveLoopLimits` the one home for budget defaults |
| `src/loop.ts` | The `Loop` seam + `nativeLoop` — the control loop as an extension point |
| `src/events.ts` | `RunEvent` + `runEventEmitter` / `recordRunEvents` — the structured run stream the loop and `EngineContext` emit |
| `src/tools/` | `Tool` + `primitiveTools` (generic) / `connectorTools`; `metadata.ts` (scoping + projections); `modelTool.ts` (a model surfaced as a tool). Domain tools are the application's, injected via `DomainToolFactory`. |
| `src/primitives/` | Sandbox primitives: `codeExec`, `fs`, `http`, `download` |
| `src/engines/` | The `AgentEngine` seam + native / claude-code / codex harnesses; the capability *mechanism* (guards, `write_file`, MCP + stdio transports) — never an application's capability set |
| `src/secrets.ts` | `secretsToEnv` |

## The seven extension points

An application extends the kernel through these seams. It should never need to
patch or fork kernel code to add a model kind, a route source, a context source,
a tool, or a control loop.

| # | Seam | Where | Kernel ships |
|---|------|-------|--------------|
| 1 | **Model kinds** | `ModelRegistry` | binds `kind`+`id` → `ModelInvocation`; fails loud when unresolved |
| 2 | **Route resolution** | `RouteResolver` | `StaticRouteResolver` (code/config, zero infrastructure) |
| 3 | **Middleware** | `Middleware` | correlation, logging, health tracking, error redaction |
| 4 | **Engines** | `AgentEngine` | native / claude-code / codex |
| 5 | **Context providers** | `ContextProvider` | parallel assembly + rendering; wired into `NativeEngine` |
| 6 | **Tools** | `Tool` + `ToolMetadata` | primitives, MCP connectors, projections, `modelAsTool`; domain tools + capabilities are injected |
| 7 | **Loop** | `Loop` | `nativeLoop` — the one loop the kernel ships, which `runAgent` also runs |

**Points 1 and 2 are different layers and must not be conflated.** A resolver
answers "which model, prompt and tools should capability X use?" and hands back
a `ModelRef`; the registry answers "which implementation is that ref?". Resolver
sits above, registry below, `ModelRef` is the handoff.
