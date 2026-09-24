# Publishing: versioning and the npm release path

Moved verbatim from the former `CLAUDE.md`.

## Versioning

What this repo owes them either way is a **truthful version**. Bump with
`npm version <v> --no-git-tag-version` — **never** a find-and-replace over
`package-lock.json`, which will happily rewrite an unrelated dependency sitting
at the same number (caught doing exactly that to `type-check` while cutting
0.5.0). Then merge, then tag the merge commit `v<version>`.

## Publishing (LIVE, and inert by default)

`@rarebit-one/harness-kernel` is **published on npm** and this repo is
**public**. Publishing runs from `publish.yml` via npmjs **OIDC trusted
publishing** — `id-token: write`, `environment: npm`, provenance attestation,
and **no `NPM_TOKEN` anywhere**.

**Creating a GitHub Release for ANY tag runs this workflow.** The single
mutating step is skipped unless the repo variable `PUBLISH_LIVE` is `"true"`;
everything else — typecheck, lint, test, build, `.d.ts` emit, version
consistency, provenance — runs regardless, and an unarmed run prints what it
*would* have published. So a Release cut by accident is a loud green no-op.

```bash
gh variable set PUBLISH_LIVE --body true --repo rarebit-one/harness-kernel
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
gh variable delete PUBLISH_LIVE --repo rarebit-one/harness-kernel   # ALWAYS
```

**Arming is a separate, reversible act from releasing. Never edit the workflow
to publish** — that makes the armed state invisible and permanent.

### Two things learned bootstrapping this (2026-08-21)

**npm cannot make a FIRST publish via OIDC.** A trusted publisher can only be
configured on a package that already exists (npm/cli#8544 — PyPI allows
pre-registration, npm does not). `0.5.1` was therefore published manually with
`npm publish --no-provenance` and has **no attestation**; `0.5.2` was the first
OIDC release and every version since carries one. If a sibling package ever
needs bootstrapping, this is the sequence, not a bug to debug.

**Going public STRANDS self-hosted CI.** Every org runner group sets
`allows_public_repositories: false` — correct, since a public repo means fork
PRs. This repo had `RUNNER_LABEL=hyperion`, so the moment it went public every
job queued forever with **nothing red**. The fix was deleting the repo variable
so `runs-on` falls through to the workflows' `|| 'ubuntu-latest'` fallback,
which costs nothing: public repos get unlimited hosted minutes. **Any repo that
goes public next needs the same variable removed, in the same breath.**
