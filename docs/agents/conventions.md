# Conventions: the kernel's design rules in full

Moved verbatim from the former `CLAUDE.md`; `AGENTS.md` keeps a one-line summary of each.

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
- **One loop implementation, one code path.** `runAgent` and `nativeLoop` both
  land in `runNativeLoop`; budget defaults live only in `resolveLoopLimits`. The
  seam exists so an application can supply DIFFERENT control flow, never so the
  kernel can carry two of its own — a second in-kernel loop is the tell that
  this rule has been broken.
- **Bookends belong to the wrapper, not the loop.** `runWithEvents` emits
  `run.started`/`run.finished` around whichever `Loop` runs; a loop emits only
  its own middle. `LoopContext` carries a `RunEventEmitter`, never a raw sink,
  so a loop physically cannot emit an unnumbered event, and that emitter's type
  (`LoopEventEmitter`) excludes the bookends so it cannot emit a duplicate one
  either. Both properties exist
  because the loop is a seam now: anything that relies on a future implementor
  remembering to do it is not a property, it is a hope.
- **The kernel names no emission.** `EngineResult.emissions` is `unknown` and is
  never parsed, validated or defaulted here; `readEmissions` returns the JSON it
  found, or `undefined` when there was none. If you find yourself adding a type
  for *what a run produced*, that is this rule being broken — the kernel carried
  `KnowledgeEntry`/`IssueEntry` for exactly that reason and they were one
  product's vocabulary sitting in a kernel.
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
