# CI: workflows and the thin-caller reusables

Moved verbatim from the former `CLAUDE.md`.

## CI

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `test.yml` | PR + push to main | typecheck → lint → format:check → test → build → `.d.ts` emit check → `npm pack` |
| `security.yml` | PR + push to main | advisory `npm audit` |
| `claude-code-review.yml` | non-draft PR | automated review, via the org-shared reusable |
| `claude.yml` | `@claude` mention | agent responds on issues/PRs |
| `dependabot-auto-merge.yml` | Dependabot PR | auto-lands green patch/minor bumps |
| `publish.yml` | GitHub Release (any tag) | **INERT** — gated on `PUBLISH_LIVE`; see `docs/agents/publishing.md` |

The three agentic/automation workflows are **thin callers** into
`rarebit-one/.github` (public, so they keep working after a public flip). Model,
effort and prompt live in the reusables, not here — don't fork the logic into
this repo. The pin gate (`pin-gate.yml`) ignores first-party
`rarebit-one/.github@main` refs, so the `@main` refs are intentional and won't
trip the pin check.
