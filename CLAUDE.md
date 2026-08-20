# CLAUDE.md

Guidance for Claude Code when working in this repository. Read `README.md` for
the public surface; this file covers conventions and the workspace rules that
apply here.

## What this repo is

**`@rarebit-one/harness-kernel`** — a provider-neutral AI-harness kernel in
TypeScript (Node 22, ESM-only). LLM adapters, a tool-use loop, MCP connectors,
sandbox primitives, and a pluggable `AgentEngine` seam.

It is a **library**, not a service: no HTTP server, no process lifecycle, no
persistence, no logging to stdout. Everything observable goes through the
caller-supplied `log` callbacks (`no-console` is an error here).

v0 is a mechanical extraction of a proven, already-decoupled agent core into a
standalone package. The mechanics carry years of production behaviour with them;
what is new is the packaging, the public API, and the brand-neutrality. The
first consumer will be migrated onto this package rather than the other way
around — the kernel never bends to a consumer.

## Layout

| Path | What it is |
|------|------------|
| `src/index.ts` | The public API. Anything not re-exported here is internal. |
| `src/types.ts` | The five shared shapes callers hand in: `ConnectorConfig`, `Permissions`, `WorkflowDefinition`, `KnowledgeEntry`, `IssueEntry`. |
| `src/models/` | The `ModelInvocation` seam (`types.ts`), the `chat` kind + `Provider` adapter (`chat.ts`), the kind registry (`registry.ts`), middleware (`middleware.ts`) |
| `src/routing/` | `RouteResolver` + the built-in `StaticRouteResolver` (capabilities as code) |
| `src/context/` | `ContextProvider` chain — `assembleContext` / `renderContext` |
| `src/providers/` | `Provider` interface + anthropic / openai / openrouter / mock adapters, `selectProvider` |
| `src/agent.ts` | `runAgent` — the tool-use loop, driven through the model seam |
| `src/events.ts` | `RunEvent` + `runEventEmitter` / `recordRunEvents` — the structured run stream the loop and `EngineContext` emit |
| `src/tools/` | `Tool` + `primitiveTools` (generic) / `connectorTools`; `metadata.ts` (scoping + projections); `modelTool.ts` (a model surfaced as a tool). Domain tools are the application's, injected via `DomainToolFactory`. |
| `src/primitives/` | Sandbox primitives: `codeExec`, `fs`, `http`, `download` |
| `src/engines/` | The `AgentEngine` seam + native / claude-code / codex harnesses; the capability *mechanism* (guards, `write_file`, MCP + stdio transports) — never an application's capability set |
| `src/secrets.ts` | `secretsToEnv` |

## The six extension points

An application extends the kernel through these seams. It should never need to
patch or fork kernel code to add a model kind, a route source, a context source
or a tool.

| # | Seam | Where | Kernel ships |
|---|------|-------|--------------|
| 1 | **Model kinds** | `ModelRegistry` | binds `kind`+`id` → `ModelInvocation`; fails loud when unresolved |
| 2 | **Route resolution** | `RouteResolver` | `StaticRouteResolver` (code/config, zero infrastructure) |
| 3 | **Middleware** | `Middleware` | correlation, logging, health tracking, error redaction |
| 4 | **Engines** | `AgentEngine` | native / claude-code / codex |
| 5 | **Context providers** | `ContextProvider` | parallel assembly + rendering; wired into `NativeEngine` |
| 6 | **Tools** | `Tool` + `ToolMetadata` | primitives, MCP connectors, projections, `modelAsTool`; domain tools + capabilities are injected |

**Points 1 and 2 are different layers and must not be conflated.** A resolver
answers "which model, prompt and tools should capability X use?" and hands back
a `ModelRef`; the registry answers "which implementation is that ref?". Resolver
sits above, registry below, `ModelRef` is the handoff.

## Development

A devcontainer is available (`.devcontainer/`) and is how this runs on
mac-mini-1 alongside the workspace's other projects. It is deliberately
**portless**: the kernel is a library, so unlike the web apps there is no
server to publish, no Caddy route and no SSH-tunnel entry — it exists for a
reproducible Node 22 toolchain, not to be reached from a browser.

`node_modules` lives in a named volume rather than the bind mount, so the
container's Linux install and the host's macOS install don't overwrite each
other. That matters because arch-specific optional packages arrive through the
dependency tree; a shared `node_modules` breaks whichever side installed last.

```bash
npm ci
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .   (lint:fix to autofix)
npm run format         # prettier --write .   (format:check to verify)
npm run build          # tsc -p tsconfig.build.json → dist/ + .d.ts
```

The offline **`mock` provider** is deliberate: the entire loop runs with **no API
keys and no network** (`selectProvider` falls back to it when no key is set).
Don't add tests that require a live provider key.

## Conventions

- **Kernel minimality is the design constraint.** The name is the forcing
  function. Anything that knows about a *specific application's* domain —
  perception routing, an orchestration plane, a product's data model — belongs
  in that application's own harness layer, not here. When you feel the urge to
  add it here, that urge is the signal it goes elsewhere.
- **Seams, not implementations.** The kernel ships an interface plus the
  in-process/static default that makes it usable with **zero infrastructure**.
  It ships no database, no schema, no control plane, no prompt-version store. A
  DB-backed `RouteResolver` is an app-layer adapter *behind* the interface —
  never in here. The tell that a seam has drifted: a field or a default that
  only makes sense for one product's tables.
- **Payload types are per kind; only the envelope is shared.** `ModelInvocation`
  keeps `Req`/`Res` generic on purpose. Collapsing a chat request and an image
  buffer into one `unknown` would erase the typing that makes a detection or
  forecast result worth having. Unify the arrow, never the payload.
- **One-way dependencies, always.** `app layer → kernel`, never the reverse. The
  kernel must never import, name, or special-case a consumer.
- **Brand-neutral, no exceptions.** No product, company, or repo name appears in
  this codebase — not in identifiers, not in wire values, not in model-visible
  strings, not in comments. Anything an application wants attributed to itself
  (OpenRouter attribution, an MCP client identity, a system prompt) is passed
  **in** by that application. Grep for a product name before you commit.
- **Generic vs. domain tools.** `primitiveTools()` stays strictly generic. The
  kernel defines **no** domain tools and **no** application capabilities at all —
  what a run may emit is the application's vocabulary. Those arrive through the
  seams: `DomainToolFactory` for the in-process loop, `CapabilityToolFactory` for
  Claude Code, and an application-owned entrypoint script for codex (a child
  process cannot be handed a closure). The only capability the kernel ships is
  `writeFileCapability`, because a sandbox write carries no product semantics.
  The workspace-scope and path guards (`denyCrossWorkspace`, `resolveWithin`) are
  exported so application capabilities inherit identical security properties
  rather than reimplementing them slightly differently.
- **Emit, never store.** The kernel produces the run event stream; it keeps
  none of it. A session store, resume, fork or replay needs persistence and a
  schema, which is the same infrastructure the "seams, not implementations" rule
  already keeps out. `recordRunEvents()` is a test recorder and a reference
  shape — if it ever grows identity, durability or a size bound, it has become
  the thing this rule forbids. Observability is also never fatal: a sink that
  throws is logged and skipped, the same treatment a failing context provider
  gets.
- **Fail loud, never silently degrade.** `AgentEngine.supports()` returns a
  reason and the caller fails the run; capabilities reject cross-workspace calls
  outright. The one deliberate exception is the offline `mock` provider fallback.
- **TypeScript strict**; `tsc --noEmit` and `eslint` must be clean (CI gates
  both, plus `prettier --check` and the `dist/index.d.ts` emit check).
- **`moduleResolution: NodeNext`** — every relative import carries an explicit
  `.js` extension. Keep it that way; a bare specifier will not resolve at runtime.
- **Public API discipline.** A new export is a compatibility commitment. Add it
  to `src/index.ts` deliberately, not incidentally.

## How consumers install it (while npm publishing is dormant)

Nothing is on npm yet, so consumers take a **pinned git dependency**:

```jsonc
"@rarebit-one/harness-kernel": "github:rarebit-one/harness-kernel#v0.2.0"
```

That works because `prepare` runs `npm run build` — npm executes `prepare` when a
package is installed from git, with devDependencies present, so `tsc` produces
`dist/` on the consumer's machine. **Don't remove the build from `prepare`**: a
git install would then resolve to a package whose `main`/`types` point at a
`dist/` that doesn't exist, and the consumer fails with a confusing module-not-
found rather than anything that names the real cause.

Pin to a **tag**, not a branch, so a consumer's build can't change under it.
Cut a tag per release: bump `version` here, merge, then tag the merge commit
`v<version>`.

Because the repo is private, CI in a consumer repo needs a credential that can
read it — in this org, a short-lived installation token from the release-bot
GitHub App plus `git config url.insteadOf`. Local development needs nothing
extra; the developer's own git credentials resolve it.

## Publishing (dormant)

The repo is **private** and **nothing has been published**. `publish.yml` is
wired for npmjs **OIDC trusted publishing** (`id-token: write`, `environment:
npm`, build provenance attestation, **no `NPM_TOKEN`**) and triggers only on
`release: published` — no Release exists, so it cannot fire. Do **not** publish,
create a Release, or flip the repo public without explicit sign-off. Everything
is arranged so the flip is a visibility toggle plus a first Release, not a
refactor.

## CI

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `test.yml` | PR + push to main | typecheck → lint → format:check → test → build → `.d.ts` emit check → `npm pack` |
| `security.yml` | PR + push to main | advisory `npm audit` |
| `claude-code-review.yml` | non-draft PR | automated review, via the org-shared reusable |
| `claude.yml` | `@claude` mention | agent responds on issues/PRs |
| `dependabot-auto-merge.yml` | Dependabot PR | auto-lands green patch/minor bumps |
| `publish.yml` | GitHub Release only | **dormant** — see below |

The three agentic/automation workflows are **thin callers** into
`rarebit-one/.github` (public, so they keep working after a public flip). Model,
effort and prompt live in the reusables, not here — don't fork the logic into
this repo. `.pinact.yaml` exempts first-party org refs, so the `@main` refs are
intentional and won't trip the pin check.

## Git hooks (lefthook)

`lefthook.yml` at the repo root (installed by `npm install`'s prepare script).
Pre-commit: Prettier `--check` + ESLint on staged files. Pre-push: `typecheck` +
`vitest`. Skip in an emergency with `LEFTHOOK=0`.

## Workspace rules (rarebit-one)

This repo lives in the `~/Workspace/rarebit-one/` workspace and follows its rules
(see the workspace `CLAUDE.md`). The load-bearing ones here:

1. **Worktree-only writes.** File modifications in the main checkout are blocked
   by a committed PreToolUse hook (`.claude/settings.json` →
   `.claude/hooks/enforce-worktree.sh`). Work in a worktree
   (`git worktree add .worktrees/<name> -b <branch> origin/main`). Don't
   sidestep via Bash writes either.
2. **Signed commits, always.** A committed hook (`enforce-signed-commits.sh`)
   injects `-S` into `git commit`. If signing fails, stop and surface the error —
   never bypass (`--no-gpg-sign` etc. are for human emergencies only).
3. **`LEFTHOOK=0` for agent-driven git operations** (`push`, `pull`, `fetch`) —
   never set it when shipping real code on a human's behalf.
4. **Merging follows workspace Rule #7**: autonomous merge only when CI is fully
   green and the PR is mergeable; never merge over a red check.
