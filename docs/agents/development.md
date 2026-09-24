# Development: devcontainer, commands and git hooks

Moved verbatim from the former `CLAUDE.md`.

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


## Git hooks (lefthook)

`lefthook.yml` at the repo root (installed by `npm install`'s prepare script).
Pre-commit: Prettier `--check` + ESLint on staged files. Pre-push: `typecheck` +
`vitest`. Skip in an emergency with `LEFTHOOK=0`.
