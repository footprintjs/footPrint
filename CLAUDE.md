# FootPrint — contributor essentials

Build a static chart, execute it once, and collect evidence during traversal.
The record says what ran, not whether it was right; absent evidence stays unknown.
Trust the code when a description disagrees with it.

This is the entry point. Before changing an area, read its README and the relevant
[contributor reference](.claude/rules/feature-work/README.md). Every prior rule,
qualification and worked example has an entry in the
[old-to-new table](.claude/rules/feature-work/migration.md).
Ordinary links keep details available without eager `@` imports.

## Public doors and the dependency fence

- `footprintjs`: build, run, decide, retry and pause; use `/advanced` for engine extensions.
- `/recorders`, `/trace`, `/detach`, `/zod` and `/sinks` are separate public doors.
- `/explain` enables run evidence and exposes the witness for the exact served log.
- The Node-only sink door owns filesystem I/O; core must remain portable.
- Foottrace owns records, codecs, readers, writers, path operations and freezing.
  Import its named public doors; never copy its laws or re-export its declarations.
- `scripts/layering.config.cjs` is the single engine layer table.
  Import only the same layer or below; keep named exceptions explicit and checked.
- Do not close builder/runner, attempt/decide/scope or recorder/attempt cycles.
  Type-only leaves and neutral helpers exist to keep those boundaries open.

Full seam details: [architecture](.claude/rules/feature-work/architecture.md).

## Module map — one job and one starting point

All areas below are under `src/lib/` unless the path says otherwise.

| Area            | Owns                                                        | Read first                                  |
| --------------- | ----------------------------------------------------------- | ------------------------------------------- |
| capture         | Bounded engine retention and evidence summaries             | [README](src/lib/capture/README.md)         |
| memory          | Stage frames, policy, run addresses and diagnostics         | [README](src/lib/memory/README.md)          |
| schema          | Duck-typed validation                                       | [README](src/lib/schema/README.md)          |
| builder         | Fluent DSL, graph construction and explicit retry loops     | [README](src/lib/builder/README.md)         |
| budget          | Static time bounds over the built graph                     | [README](src/lib/budget/README.md)          |
| scope           | Per-stage facade, argument ownership and recorder access    | [README](src/lib/scope/README.md)           |
| reactive        | Typed state proxies and stage-bound handles                 | [README](src/lib/reactive/README.md)        |
| decide          | Decision and selector evidence                              | [README](src/lib/decide/README.md)          |
| filter          | Shared comparison, filter-rule and first-match laws         | [README](src/lib/filter/README.md)          |
| attempt         | One retry runner, categories, deadlines and call attempts   | [README](src/lib/attempt/README.md)         |
| timers          | One long-timer law; never wrap long waits into short timers | [README](src/lib/timers/README.md)          |
| ids             | Reserved IDs and generated branch-segment grammar           | [README](src/lib/ids/README.md)             |
| recorder        | Composed stores, hook routing and recorder snapshots        | [README](src/lib/recorder/README.md)        |
| pause           | Checkpoint admission, interrupts and resume contracts       | [README](src/lib/pause/README.md)           |
| errors          | Structured errors and native terminal-failure ownership     | [README](src/lib/errors/README.md)          |
| engine          | Traversal, graph resolution and narrative dispatch          | [README](src/lib/engine/README.md)          |
| engine/handlers | Stage, subflow, fork and resume execution                   | [README](src/lib/engine/handlers/README.md) |
| runner          | Executor wiring, observers, snapshots and run lifecycle     | [README](src/lib/runner/README.md)          |
| observer-queue  | Pure deferred-delivery pipeline                             | [README](src/lib/observer-queue/README.md)  |
| sinks           | Bounded crash-safe Node file I/O                            | [README](src/lib/sinks/README.md)           |
| contract        | Input/output schema normalization                           | [README](src/lib/contract/README.md)        |
| detach          | Explicit scheduling drivers and child handles               | [README](src/lib/detach/README.md)          |

## Execution and record invariants

- `StageContext` composes Foottrace's `RecordFrame`; encoding, staging and replay
  belong to Foottrace. Writers copy before changing committed generations.
- Reads are borrowed references. Never mutate the committed heap or a reader's log.
  `getSnapshot()` serves records through Foottrace's freeze/copy law.
- Stamp `runtimeStageId` before events. Execution indices are globally monotonic
  within the run and continue across resume; a fresh leg gets its own `runId`.
- One executor runs one operation at a time. Stored state must survive `structuredClone`.
- A failed stage commits its staged writes before reporting and rethrowing.
  Commit-on-error is intentional; it is not rollback. Preserve the original exception.
- A retry is policy on a stage, not a new node kind. Keep one runtime stage identity
  and commit bundle; discard failed non-final staging, not attempt history.
- Pause and abort are never retried. Keep the existing promise/microtask ordering.
- Subflows have isolated runtimes. Mappers use the tracked mount view, not raw state;
  preserve their reads, inherited redaction and array merge policy.
- Resume re-enters each pause-path mount once, then follows the real chart.
  A stand-in is an entry node, never a graph lookup replacement or loop target.
- Skip `isLoopRef` before graph searches that assume unique node IDs.
  Forward loops accumulate state and remain bounded; nothing rewinds the heap.
- Recorders compose stores and never abort traversal when their hooks throw.
  `recorder/hooks.ts · HOOKS` is the one runtime hook registry.
- Fresh runs clear attached recorders; resume preserves them. Snapshot rows are
  unique by recorder ID across channels and delivery tiers.
- Deferred observer capture defaults to `clone`, not `summary`.
  Lifecycle cleanup is bounded and must not invalidate a usable pause.

Details and qualifications: [execution](.claude/rules/feature-work/execution.md),
[invariants](.claude/rules/feature-work/invariants.md),
[failure and resume](.claude/rules/feature-work/failure-and-resume.md).

## Privacy, ownership and retained evidence

- `memory/redaction.ts · RedactionRule` decides selection; Foottrace writes scrub bytes.
  Every library-retained/served surface obeys policy, including observer and saved records.
- Live state, resume state, operational rejection and live fork results remain real.
  Select by name and provenance, never by searching text for matching secret values.
- The staged-write funnel owns marks and identity inheritance. A mark ends only
  when its last place is truly deleted and committed; staged deletion is insufficient.
- Serve one safe form where the value is produced. No recorder-local rescrub,
  inferred native origin or second tree walk may repair missed retention.
- Preserve the separate historical scope and log placeholders and explicit unknowns.
- `capture/explainWitness.ts` binds the witness to the served object. A mounted child's served note follows the live privacy rule.
- Native terminal context comes from the actual pending failure, never mutable event
  context or reconstructed history. Unknown setup, sink and cancellation errors borrow no stage.
- Observability dials and native IDs retain their existing owners and public codecs.
  Keep physical attempts distinct from logical reconciliation decisions.

The complete identity, cost, diagnostic and source-selection laws remain in
[change impact](.claude/rules/feature-work/change-impact.md).
For current error-source retention read
[stage-error retention](src/lib/memory/stageErrorRetention/README.md) and
[failure receipts](src/lib/errors/failureRetention/README.md).

## Landmines that cause silent bugs

- Typed assignments must not JSON-round-trip values. Detach once at commit;
  uncloneable values fail there, and failed commits must report the real failure.
- An assigned array replaces; `$update` keeps its append law. Holes become `null`.
- Borrowed values from `find`, `filter`, iteration or raw read doors can mutate
  committed state invisibly. Stage-bound proxies are refused after their stage.
- A held array whose key no longer holds an array cannot write or revive that key.
- Fork break propagation is unwired in real runs; do not promise it works.
- Keep the documented cyclic terminal-proxy, separator-key and array-expando limits.
- A custom scope must register its runtime port explicitly; do not probe arbitrary
  user fields as an ownership fallback.
- Snapshot bundle fields are copied explicitly. New fields need the copy list and
  every channel signature, or they disappear silently.

Full cases, historical fixes and pinned limitations:
[landmines](.claude/rules/feature-work/landmines.md).

## Changing a seam

- Read the [extension checklist](.claude/rules/feature-work/extensions.md) before
  adding a stage kind, hook, scope method, provider, contract, driver or dial.
- Preserve every type-union/serialization site, structure-event order and hook registry.
  Prefer graph sugar when the existing node shape already fits.
- Use the [change-impact map](.claude/rules/feature-work/change-impact.md) for
  write addresses, checkpoints, IDs, subflow prefixing, sinks and traverser phases.
- [Attempt metrics](.claude/rules/feature-work/attempt-metrics.md) keep only bounded,
  admitted retained facts; unknowns and omissions stay disclosed.
- [Stage attention](.claude/rules/feature-work/stage-attention.md) copies bounded
  native marks; it never scans arbitrary values or infers recorder quality.
- For the actual traversal order, use the
  [walkthrough](.claude/rules/feature-work/walkthrough.md).
- The seven execution/replay/query mechanisms remain distinct; see
  [backtracking](.claude/rules/backtracking.md). None is state rollback.

## Validation, review and release

Use Node 24 LTS and npm 11; CI also tests Node 22. Read
[CONTRIBUTING](CONTRIBUTING.md) before changing dependencies or published doors.

- Keep one installed Foottrace and the intentional lock, baseline and reference pins.
  Do not refresh unrelated dependencies or hide a consumer regression downstream.
- For changed behavior, preserve original reds, test the public/observer surfaces,
  use meaningful fault probes and run applicable hosted gates.
- Full installs, builds, suites and coverage go hosted first. Local focused probes
  are bounded; an exceptional heavy local run needs the current owner-approved window.
- A review applies to one exact head. Changed heads need their own verdict and gates.
  Follow the current owner-assigned merge/release route; a lane must not self-approve.
- Use normal reviewed PRs; never force, use admin bypass, skip verification or hand publish.
  A merge commit only combines, apart from actual conflict resolution.
- Keep source files at 600 lines or below; existing oversized owners may only shrink.
  Do not raise their ratchet to pass a check. Every module needs its README and tests.
- Root instructions stay within 200 lines and 20 KB, with no line over 500 characters.
  Move detail to its owner and update the migration links rather than pack long lines.
- `AGENTS.md` and `ai-instructions/` are generated from `ai-instructions/source/`.
  Change the source and run `npm run ai:generate`; never edit the generated copies alone.

Applicable commands: `npm test`, `npm run build`, `npm run lint`, `npm run format`,
`npm run check:layering`, `npm run check:doc-paths`, `npm run check:doc-snippets`,
`npm run check:ai-instructions`, and the API-door/doc checks in CONTRIBUTING.
Run examples as integration tests. Passing snippet compilation proves types, not output.
