# AGENTS.md

Guidance for coding agents in this repository. Read `README.md` for the public
surface; this file holds what the code can't tell you and routes to
`docs/agents/` for the rest.

## What this repo is

**`@rarebit-one/harness-kernel`** — a provider-neutral AI-harness kernel in
TypeScript (Node 22, ESM-only). LLM adapters, a tool-use loop, MCP connectors,
sandbox primitives, and a pluggable `AgentEngine` seam.

It is a **library**, not a service: no HTTP server, no process lifecycle, no
persistence, no logging to stdout. Everything observable goes through the
caller-supplied `log` callbacks (`no-console` is an error here).

`src/index.ts` is the public API; anything not re-exported there is internal.
An application extends the kernel through seven seams (model kinds, route
resolution, middleware, engines, context providers, tools, loop) and should
never need to patch or fork kernel code. **Route resolution (`RouteResolver`)
and model kinds (`ModelRegistry`) are different layers**: the resolver hands
back a `ModelRef`, the registry resolves it. Layout and the seam table:
`docs/agents/architecture.md`.

## Commands

```bash
npm ci
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .   (lint:fix to autofix)
npm run format         # prettier --write .   (format:check to verify)
npm run build          # tsc -p tsconfig.build.json → dist/ + .d.ts
```

CI gates typecheck, lint, `prettier --check`, tests, and the `dist/index.d.ts`
emit check. The offline **`mock` provider** runs the whole loop with no API keys
and no network (`selectProvider` falls back to it when no key is set): **don't
add tests that require a live provider key.**

## Invariants

Each has a one-line reason here; the full text is in
`docs/agents/conventions.md`.

- **Kernel minimality.** Anything that knows a specific application's domain
  belongs in that application's harness layer — the urge to add it here is the
  signal it goes elsewhere.
- **Seams, not implementations.** Ship an interface plus a zero-infrastructure
  default, never a database, schema or control plane — a field that only fits
  one product's tables means the seam has drifted.
- **Payload types are per kind; only the envelope is shared.** Collapsing
  `Req`/`Res` into `unknown` erases the typing that makes a result worth having.
- **One-way dependencies.** `app layer → kernel`; the kernel never imports,
  names or special-cases a consumer.
- **Brand-neutral, no exceptions.** No product, company or repo name in
  identifiers, wire values, model-visible strings or comments; attribution is
  passed **in** by the application. Grep for a product name before you commit.
- **No domain tools, no application capabilities.** `primitiveTools()` stays
  generic; `writeFileCapability` is the only shipped capability, and the guards
  (`denyCrossWorkspace`, `resolveWithin`) are exported so apps inherit them.
- **One loop implementation.** `runAgent` and `nativeLoop` both land in
  `runNativeLoop`; budget defaults live only in `resolveLoopLimits`. A second
  in-kernel loop is the tell this is broken.
- **Bookends belong to the wrapper.** `runWithEvents` emits
  `run.started`/`run.finished`; `LoopEventEmitter` makes a loop unable to emit
  them, because a seam property that relies on implementors remembering is a hope.
- **The kernel names no emission.** `EngineResult.emissions` stays `unknown` and
  is never parsed here; a type for *what a run produced* is product vocabulary.
- **Emit, never store.** No session store, resume or replay — that needs
  persistence. A throwing sink is logged and skipped, never fatal.
- **Fail loud.** `AgentEngine.supports()` returns a reason and the caller fails
  the run. The one deliberate exception is the offline `mock` fallback.
- **`moduleResolution: NodeNext`.** Every relative import carries an explicit
  `.js` extension; a bare specifier will not resolve at runtime.
- **Public API discipline.** A new export in `src/index.ts` is a compatibility
  commitment — add it deliberately.

## Footguns

- **Bump the version with `npm version <v> --no-git-tag-version`**, never a
  find-and-replace over `package-lock.json`, which rewrites unrelated
  dependencies at the same number. Then merge, then tag the merge commit
  `v<version>`.
- **Any GitHub Release runs `.github/workflows/publish.yml`.** It publishes only
  when the repo variable `PUBLISH_LIVE` is `"true"`: arm it, release, then
  delete it. Never edit the workflow to publish (the armed state goes invisible).
- **npm cannot make a first publish via OIDC**; a new sibling package needs one
  manual publish before trusted publishing can be configured.
- **This repo is public**, so org self-hosted runners won't take its jobs. Keep
  `runs-on` falling back to `ubuntu-latest`; a runner-label variable here queues
  every job forever with nothing red.

## Workspace rules

This repo follows the rarebit-one workspace rules; the load-bearing ones:

1. **Worktree-only writes.** A committed PreToolUse hook
   (`.claude/settings.json` → `.agents/hooks/enforce-worktree.sh`) blocks edits
   in the main checkout. Work in `git worktree add .worktrees/<name> -b <branch>
   origin/main`, and don't sidestep it with Bash writes.
2. **Signed commits.** `.agents/hooks/enforce-signed-commits.sh` injects `-S`.
   If signing fails, stop and surface the error; never bypass it.
3. **Lefthook** (`lefthook.yml`) runs Prettier + ESLint pre-commit and
   typecheck + vitest pre-push. `LEFTHOOK=0` is for routine git only, never for
   shipping code.
4. **Merge only on green**: CI fully green and the PR mergeable; never merge
   over a red check.

## Where things live

| Topic | File |
|-------|------|
| Source layout, the seven extension points | `docs/agents/architecture.md` |
| Design conventions in full | `docs/agents/conventions.md` |
| Devcontainer, commands, git hooks | `docs/agents/development.md` |
| Versioning, npm publishing, bootstrap lessons | `docs/agents/publishing.md` |
| CI workflows | `docs/agents/ci.md` |
| Public API and usage | `README.md` |
