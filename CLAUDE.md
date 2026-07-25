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
| `src/providers/` | `Provider` interface + anthropic / openai / openrouter / mock adapters, `selectProvider` |
| `src/agent.ts` | `runAgent` — the provider-neutral tool-use loop |
| `src/tools/registry.ts` | `Tool`, `primitiveTools` (generic), `emissionTools` (domain, injectable), `connectorTools` |
| `src/primitives/` | Sandbox primitives: `codeExec`, `fs`, `http`, `download` |
| `src/connectors/` | `connectMcp` — MCP over stdio / streamable HTTP / SSE |
| `src/engines/` | The `AgentEngine` seam + native / claude-code / codex harnesses + the shared capability surface |
| `src/secrets.ts` | `secretsToEnv` |

## Development

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
- **One-way dependencies, always.** `app layer → kernel`, never the reverse. The
  kernel must never import, name, or special-case a consumer.
- **Brand-neutral, no exceptions.** No product, company, or repo name appears in
  this codebase — not in identifiers, not in wire values, not in model-visible
  strings, not in comments. Anything an application wants attributed to itself
  (OpenRouter attribution, an MCP client identity, a system prompt) is passed
  **in** by that application. Grep for a product name before you commit.
- **Generic vs. domain tools.** `primitiveTools()` stays strictly generic.
  Domain-emission tools (`promote_knowledge`, `record_issue`) live in
  `emissionTools()` and are composed in by the caller.
- **Fail loud, never silently degrade.** `AgentEngine.supports()` returns a
  reason and the caller fails the run; capabilities reject cross-workspace calls
  outright. The one deliberate exception is the offline `mock` provider fallback.
- **TypeScript strict**; `tsc --noEmit` and `eslint` must be clean (CI gates
  both, plus `prettier --check` and the `dist/index.d.ts` emit check).
- **`moduleResolution: NodeNext`** — every relative import carries an explicit
  `.js` extension. Keep it that way; a bare specifier will not resolve at runtime.
- **Public API discipline.** A new export is a compatibility commitment. Add it
  to `src/index.ts` deliberately, not incidentally.

## Publishing (dormant)

The repo is **private** and **nothing has been published**. `publish.yml` is
wired for npmjs **OIDC trusted publishing** (`id-token: write`, `environment:
npm`, build provenance attestation, **no `NPM_TOKEN`**) and triggers only on
`release: published` — no Release exists, so it cannot fire. Do **not** publish,
create a Release, or flip the repo public without explicit sign-off. Everything
is arranged so the flip is a visibility toggle plus a first Release, not a
refactor.

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
