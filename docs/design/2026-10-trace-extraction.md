# Extracting the record into its own package — the plan (2026-10-08)

**Status:** PLAN, the order of work the owner approved on 2026-10-08/09. It replaces three working notes in the org folder (outside this repository) where they conflict: `RECORD-LIBRARY-DESIGN.md`, `RECORD-LIBRARY-DESIGN-REVIEW.md` and `FP-WRITER-DOOR-DESIGN.md` (section 3 says what changed). Facts were read off footprintjs `origin/main` `34370cc7` (9.44.1, plus the consumer audit #60 and the byte fixtures #61), the C1 branch `refactor/c1-record-commit` (`9225b856`), and each consumer's `origin/main` on 2026-10-08. The counting scripts are listed in the appendix.

**Two kinds of reader.** Sections 0–3 are for the owner: plain words. Sections 4–9 are for the agents who do the work: exact files, symbols and checks.

## 0. On one screen

- **The goal.** The record becomes its own small package, **foottrace** (working name). The record is what a run wrote, plus every reader of it: the fold, the time-travel cursor, the stops, the slices and the honesty codes. footprintjs becomes flowchart + trace: it depends on foottrace and re-exports nothing from it.
- **Simplify first, then move.** Six small clean-up steps (C1–C6) happen inside footprintjs. They move the record's half of the stage frame out of `StageContext` and cut every tie from the record to the engine. Each step changes no byte of any record, ships on its own, and is checked against every consumer. C1 is built. Then six extraction steps (E1–E6) get the tests and the consumers ready, publish foottrace 1.0.0, move the consumers, and ship footprintjs 10.0.0.
- **No new writer.** The extra writer wrapper of the writer-door design is dropped. After C5, the cleaned record layer itself (`RecordFrame`, `SharedMemory`, `EventLog`) is the public way to write a record: `footprintjs/write`, later `foottrace/write`. The engine writes through the same classes, so there is only one writer.
- **The safety net is in place.** The consumer audit (#60) runs seven consumers against every release candidate. The byte fixtures (#61) pin 26 flowchart records and hcifootprint's real transitions. A step that moves a byte or breaks a consumer cannot merge.
- **"Ready" is measured.** Six numbers are printed in every release PR (section 8). The two main ones: no record file reaches the engine, and at least 70% of the record's tests run without the engine (35% today).
- **Versions.** foottrace starts at 1.0.0. footprintjs takes a major (10.0.0) for the move. A minor that removes the readers from `footprintjs/trace` would break every published consumer on a fresh install. Consumers move first, with ranges that accept footprintjs 9 or 10, so footprintjs's major forces none of them into a major of its own.
- **Still open:** the name, major vs minor, the optional co-change condition, the `/testing` kit, the repository, and one change in the paused vizfootprint (section 10).

## 1. The layers, before and after

```
BEFORE — footprintjs 9.44: one package; the record is L0–L3 inside it
 L8  doors        .   /advanced   /recorders   /trace   /detach   /zod
 L7  builder + executor
 L6  engine
 L5  scope, recorders, hooks
 L4  frame + run policy   StageContext — and it also shapes record bytes: the bundle (C1), the run
                          address (C2), the first-touch base, the read tiers, readKeys (C3), redaction bytes (C4)
 ───────────────────────── the record ─────────────────────────
 L3  log + readers        EventLog, logModel, commitLogUtils, backtrack, slice/, time-travel/
 L2  staging + commit     TransactionBuffer, admission, deltaEncoding, SharedMemory, redaction.ts (verdict AND scrub)
 L1  verb law             verbs.ts, utils.ts
 L0  leaves               paths, equality, merge, pathOps, types.ts (record AND engine types), honesty,
                          placeholders, keyPaths, eventPosition, ids/ (grammar AND id-door refusals), capture/freeze

AFTER — footprintjs 10 + foottrace 1
 footprintjs 10                                     foottrace 1 (zero runtime dependencies)
 L8  doors  .  /advanced  /recorders  /trace*       doors:  .  (readers + record types)   /write  (the record layer)
            /detach  /zod
 L7  builder + executor                             L3  RecordFrame, recordCommit, EventLog, logModel,
 L6  engine                                             commitLogUtils, backtrack, slice/, time-travel/, CommitRangeIndex
 L5  scope, recorders, hooks                        L2  TransactionBuffer, admission, deltaEncoding, SharedMemory, scrub
 L4  StageContext (composes RecordFrame), ──────▶   L1  verbs.ts, utils.ts
     run policy, redaction verdict                  L0  paths, equality, merge, pathOps, record types, honesty,
 L0–L1  engine leaves: errors/, schema/, pause/,        log placeholder, keyPaths, eventPosition, id grammar, freeze
        capture/, observer-queue/, devMode,
        id-door refusals, the `~` segment grammar
 * footprintjs/trace keeps only the recorder-side tools (stores, recorders, walkSubflowSpec, `~` segments).
```

## 2. What the owner decided (2026-10-08/09)

1. **The long-term goal:** a trace package holding the record and every reader (fold, cursor and time travel, stops, slices, honesty codes); footprintjs = flowchart + trace.
2. **Simplify rather than add code.** Clean up first, by moving and de-duplicating. The writer wrapper (`openRecord`) of FP-WRITER-DOOR-DESIGN §2 is dropped. The cleaned record layer itself becomes the public way to write records (C5).
3. **The order:** the safety net (consumer audit #60, byte fixtures #61: done) → C1…C6, each small, byte-identical, reviewed and released → the extraction. C1 is built (`9225b856`) and waits for footprintjs 9.44.2 (#62, record truth) to ship first.
4. **No deprecation shims.** `/advanced` may break in a minor when the CHANGELOG names the break with a migration, every consumer migrates in the same train, and the consumer audit proves it. C2 is the first such change: `memory/utils.ts · getRunAndGlobalPaths` and `SharedMemory · getValue/setValue/updateValue(runId, …)` change cleanly. hcifootprint builds its `SharedMemory` (through `new ExecutionRuntime(...)`), so it updates in the same train if the audit says it must.
5. **Facade + layers + small modules + small standalone packages** (standing rule).

## 3. What this plan replaces

| Earlier note | What it proposed | Now |
|---|---|---|
| `RECORD-LIBRARY-DESIGN.md` (first design) | Extract L0–L3 at once; move the writer behind a new `Pen`/`Frame` port; one train with footprintjs 10.0.0; tree features (`pathTo`, `compare`, `joinByCorrelation`); name `foottrail` | **Superseded** on the order (clean-up first), on the writer (no new port: C3–C5 make the existing layer the writer) and on scope (tree features and viz adapters are not in this plan). **Kept:** the reader laws, "what not to extract", no per-entry `format` field, `runtimeStageId` keeps its name, foottrace starts at 1.0.0, footprintjs re-exports nothing. |
| `RECORD-LIBRARY-DESIGN-REVIEW.md` (verdict RETHINK) | No package now; a writer door owned by footprintjs; extract readers only on a measured trigger | **Superseded** on the goal: the owner chose the package. Its findings feed the steps: B1 → C1–C4, B3 → the optional co-change row, B4 → E1, B6 → E2 and E5, N1 → C6, N2 → C4, N5 → C6. B5 (viz's fold) stays out of scope. |
| `FP-WRITER-DOOR-DESIGN.md` | `openRecord` on `/write`; a `/testing` kit; an overlap rule for door moves; C1–C7; a six-row trigger | **Superseded:** the wrapper and the overlap rule are dropped; C7 is folded into C6; `/testing` and the co-change row become optional. **Kept:** the §7.2 clean-up, the consumer audit, the byte fixtures and their re-pin policy. |

## 4. The rules every step follows

**The gate.** Every C and E step passes all six before it merges:

1. **Bytes.** `test/fixtures/record-bytes/pinned/*.json` and `test/fixtures/hcifootprint/transitions-2.6.1.json` are unmodified, and `npx vitest run test/fixtures` is green without `RECORD_BYTES_REPIN`. A refactor never re-pins (`test/fixtures/README.md`).
2. **Consumers.** The consumer audit (`.github/workflows/consumers.yml`) is green on the PR, and `scripts/release.sh` gate 1b passes before the tag.
3. **Fence.** `npm run check:layering`, `npm run lint` and `test/architecture/` are green.
4. **Cost.** The counted guards stay green (`test/lib/memory/boundary/commit-cost-independent-of-state.test.ts`, `test/lib/memory/scenario/copy-on-write-witness.test.ts`). `npx tsx bench/commit-clones.ts` gives identical clone counts on every row. `npm run bench` then `npm run bench:compare` reports no regression.
5. **Suite.** `npm test`, `npm run test:examples` and `npm run build` are green.
6. **Law and review.** The folder's README states the step's law with an example. CLAUDE.md's map follows when a seam moves. One focused reviewer also checks that moved code has tests of its own (risk 5).

**Releases.** One step, one release, before the next step starts. An internal-only change is a patch. Anything a consumer can see on a door, `/advanced` included, is a minor. footprintjs takes a major only at E6. The version numbers below assume nothing else ships in between; the patch-or-minor kind is the rule.

**Door changes.** No shims and no second doors. Before E6, no symbol leaves a public door (`.`, `/trace`, `/recorders`); a symbol may leave `/advanced`, with the CHANGELOG migration. A consumer that uses it migrates in the same train: the footprintjs PR points that consumer's `branch` in `scripts/family.json` at its migration branch, the audit proves the pair, and the entry returns to `main` once both have merged.

## 5. The clean-up: C1–C6 (inside footprintjs)

### C1 — The record's half of a commit is one function (BUILT)

- **Moves:** `StageContext · bundleFor`, `untrackedSourcesFragment`, `tagsFragment` and `finishCommit` become NEW `memory/recordCommit.ts` (L3), `recordCommit(payload, stamp, { state, mirror?, log? })`, with `CommitStamp`, `CommitTargets` and `CommitPayload`. It owns the bundle's key order, the empty commit, both `scrubPatch` calls, the live and mirror `applyPatch`, and `EventLog · record`.
- **Consumers:** none.
- **Done when:** `StageContext · commit` calls it. Done in `9225b856`: fixtures unmodified, clone counts unchanged.
- **Release:** the patch after 9.44.2 (expected **9.44.3**).

### C2 — The write address is data

- **Moves:** the run namespace leaves the record layer. These take the address, a path prefix the engine computed (`['runs', id]` or `[]`), instead of a run id: `memory/utils.ts · getRunAndGlobalPaths`, `setNestedValue` and `updateNestedValue`, and `SharedMemory · getValue`, `setValue` and `updateValue`. `SharedMemory · getRuns` is deleted (one test reads it). `TransactionBuffer` already takes `address` (9.30.0). The engine keeps the decision: `StageContext · withNamespace` and `getTransactionBuffer` build the address from one L4 constant.
- **Consumers:** all of these are public on `/advanced`; the CHANGELOG says "pass `['runs', id]` where you passed `id`". No audited consumer calls them (checked 2026-10-08). hcifootprint builds its `SharedMemory` only through `new ExecutionRuntime(...)`. agentfootprint's `test/helpers/typedScope.ts` only calls `new SharedMemory(state)`. If the audit goes red for hcifootprint, its fix ships in the same train.
- **Done when:** no `'runs'` literal in an L0–L3 file except `RedactionRule · verdictOfRead`, which C4 lifts to L4.
- **Release:** minor (expected **9.45.0**).

### C3 — The record half of the frame is one class

- **Moves:** NEW `memory/RecordFrame.ts` (L3) takes from `StageContext`:
  - the first-touch base (`firstTouchState`);
  - the two-tier reads with `TransactionBuffer · detachBase` (`readState`);
  - the lazy buffer (`getTransactionBuffer`);
  - the `readKeys` list (`_provenanceReads` and the `readKeysProvider` closure);
  - the address from C2.

  `RecordFrame` is the facade over the record's small modules and calls `recordCommit`. `StageContext` composes one `RecordFrame` and keeps everything that belongs to a stage inside a run: retention (`retainedWrites`, `materialiseWrites`), diagnostics, the dev-mode warnings (`warnOnBorrowedMutation`, `warnOnCommittedMutation`), the commit observer, `discardStaged` (which calls the frame's discard), and the redaction verdict per write until C4.
- **Consumers:** the public `StageContext · getTransactionBuffer` (`/advanced`) goes; no audited consumer calls it. The constructor and the read and write methods keep their signatures (agentfootprint's test helper builds a `StageContext`).
- **Done when:** `StageContext` has no `TransactionBuffer` field, every state read goes through its `RecordFrame` (it still hands the heap and the log to the frames it creates), and `RecordFrame` has engine-free unit tests.
- **Release:** minor (expected **9.46.0**).

### C4 — One verdict owner, one encoding owner

- **Moves:**
  - **The bytes of a verdict** move into the frame. `RecordFrame · write(path, value, verb, { whole, fields })` replaces two calls inside `StageContext · stageWrite`: `buffer.set/merge/delete(…, whole)` and `buffer.markRedactedFields(path, fields)`.
  - **The scrub** moves out of `memory/redaction.ts`. `scrubPatch` and `redactPatch` go to a new record leaf, `memory/scrub.ts` (L2).
  - **The placeholders split by owner** (review N2). `memory/placeholders.ts` keeps `LOG_PLACEHOLDER`, a record byte; `SCOPE_PLACEHOLDER` moves to the verdict's side. Each README names the other placeholder; this replaces F4a's "two placeholders, one leaf".
  - **The decision** (`stageWrite`'s rule: marks and identity inheritance) becomes one function beside `RedactionRule`.
  - **The verdict is re-ranked.** In `LAYERS`, `memory/redaction.ts` moves from L2 to L4, beside `runPolicy.ts`, which carries it. Once `scrubPatch` has left, only L4+ files import it.
- **Consumers:** none (`redactPatch` keeps its `/advanced` door until C5).
- **Done when:** `stageWrite` is two calls (the verdict, then `RecordFrame · write`), and no record file imports `redaction.ts`. This closes C1's `recordCommit.ts → redaction.ts` edge.
- **Release:** patch (expected **9.46.1**).

### C5 — The record layer is the public way to write

- **New door `footprintjs/write`** (`src/write.ts`, L8). It hands out `RecordFrame`, `SharedMemory` and `EventLog` with their option types, plus `WriteProvenanceMode` (on no door today). There is no wrapper: a writer uses the classes the engine uses. From this release, `/write`'s names and bytes are promised under the fixtures' re-pin policy.
- **Door hygiene, same release.** Each record symbol gets one record door:
  - `CommitBundle`, `TraceEntry`, `MemoryPatch` and `applySmartMerge` move from `/advanced` to `/trace`.
  - The nine `/advanced` second doors close (`ExecutionCounter`, `UntrackedSource`, `buildRuntimeStageId`, `createExecutionCounter`, `findCommit`, `findCommits`, `findLastWriter`, `parseRuntimeStageId`, `pathSegments`), so `SECOND_DOORS` drops from 28 to 19.
  - `SharedMemory` and `EventLog` move to `/write`.
  - No audited consumer imports these, so they leave the public surface: `TransactionBuffer`, `deepSmartMerge`, `getNestedValue`, `setNestedValue`, `updateNestedValue`, `updateValue`, `normalisePath`, `getRunAndGlobalPaths`, `redactPatch`.
  - `test/architecture/exports.test.ts` expects seven doors.
- **Consumers, same train:**
  - **hcifootprint 2.7.0** writes through `/write` instead of `ExecutionRuntime` + `newRoot` + `ScopeFacade` + the `ScopeRecorder` read tap (`session.ts · #commitDelta`). It imports `CommitBundle`, `ExecutionCounter`, `buildRuntimeStageId` and `createExecutionCounter` from `/trace`.
  - **agentfootprint** moves `CommitBundle` and `applySmartMerge` (`src/lib/time-travel/keyedFold.ts`) to `/trace`, and its test helper's `SharedMemory` to `/write`.
- **Done when:** `test/fixtures/hcifootprint/hcifootprint-2.6.1.test.ts` replays the stored transitions through `/write` to the stored bytes, beside its 2.6.1 replay. No audited consumer imports a record symbol (section 7.5) from `/advanced`.
- **Release:** minor (expected **9.47.0**).

### C6 — The record names nothing outside itself

This step absorbs FP-WRITER-DOOR's C7 (the ids split): both serve one check, that the record imports nothing outside itself.

- **Moves:**
  - **(a) The engine types leave `memory/types.ts`** for an engine-side file placed at L4: `ScopeFactory`, `StageSnapshot`, `FlowMessage`, `FlowControlType`, `ReadTrackingMode`, `WriteTrackingMode`, and the re-exports from `capture/policies.ts` and `capture/summarize.ts`. This deletes the only `TYPE_ONLY_ALLOWANCES` entry below L4.
  - **(b) The readers name a record-owned structural type for the tree they read.** These are the fields that `commitStops`, `tagStops`, `bundles.ts · readTree` and `keysReadFromExecutionTree` touch. `timeTravel.ts` already does the same for the served subflow result (`SubflowResultShape`).
  - **(c) The ids split.** `ids/runtimeStageId.ts` keeps build, parse and read. `refuseReservedId` (with `IdPosition`) and its import of `ids/branchSegment.ts` move to the engine's id doors.
  - **(d) The dev-mode truncation warning goes** from `memory/backtrack.ts`. Truncation is already data (`root.truncated`); `test/lib/memory/backtrack-weigh-truncation.test.ts` is updated.
  - **(e) The record set becomes data.** `scripts/layering.config.cjs` gains `RECORD_FILES`, and `check:layering` fails on any import from a record file to a file outside it.
- **Consumers:** none. The public types keep their doors. Reader signatures that named `StageSnapshot` now name a supertype of it, so callers and `TimeTravelStrategy` implementers compile unchanged. The audit proves it.
- **Done when:** R1 and R2 of section 8 are 0.
- **Release:** minor, since public signatures widen (expected **9.48.0**).

## 6. The extraction: E1–E6

### E1 — The record's tests stand on their own (footprintjs)

- **Two scripts.** Check in `scripts/record-tests.mjs`, a test classifier with a named list of tests that stay with footprintjs. Check in `scripts/trace-ready.mjs`, which prints section 8's table in every release PR.
- **Convert the tests that run a chart only to get a record.** They either write the record through `/write`, or read a stored record. The 26 pinned records in `test/fixtures/record-bytes/pinned/` were written by the engine, and reading them needs no engine.
- **Name the engine witnesses that stay in footprintjs and run against foottrace:**
  - `time-travel/conformance.test.ts` (walking equals replaying);
  - `time-travel/chain.test.ts` (pause and resume legs);
  - the copy-on-write differentials driven by `memory/property/copy-on-write-fixture.ts` (footprintjs plus `footprintjs-baseline` 9.28.0);
  - the record-bytes fixtures.
- **The audit's measure.** Its "record symbols" count switches to section 7.5's definition: a symbol declared in a record file.
- **Done when:** R4 is 70% or more. **Release:** none needed (tests and scripts only).

### E2 — No consumer reads a door off a namespace

- **The Lens.** `src/core/tags/tagAxis.ts · tagStopsStrategy` and `src/core/context/contextAt.ts · firstSegment` read `tagStops` and `pathSegments` off `import * as trace from 'footprintjs/trace'`. They become named imports; the peer floor `^9.26.0` already ships both.
- **A check.** A check refuses `import * as … from 'footprintjs…'` in `src/`. The Lens has no ESLint, so a one-file architecture test does it there; agentfootprint adds the same rule to its `.eslintrc.js`. The playgrounds are exempt: they hand whole doors to user code on purpose (E5).
- **Done when:** R6 is 0. **Release:** a Lens patch.

### E3 — Build foottrace and the extraction branch (no release)

- **Entry gate:** section 8 is all green, and the owner has ruled on section 10.
- **The foottrace repository** is created with the moved files' history (`git filter-repo`). It holds:
  - the `RECORD_FILES` and their engine-free tests and READMEs;
  - `docs/guides/record-contract.md` and `examples/post-execution/time-travel/06-bring-your-own-record.ts`;
  - the hcifootprint fixture with its `/write` replay;
  - its own L0–L3 fence, an `exports.test.ts` for two doors, `honesty-vocabulary.test.ts`;
  - CI with the family's packaging gates (publint, attw);
  - a CHANGELOG 1.0.0 that names each symbol's old door.
- **The footprintjs branch `extract/foottrace`:**
  - deletes the record files and depends on the foottrace candidate;
  - imports foottrace only through its doors (lint: no `foottrace/*` path except `/write`);
  - removes the record symbols from its own doors and adds the cross-package rule (7.3);
  - retires the hcifootprint fixture's 2.6.1 frame replay: its JSON moves to foottrace, no consumer writes through the frame after C5, and the 26 flowchart records still pin the frame;
  - rewrites what teaches the old door: 35 example files, 7 docs, the 6 `ai-instructions/` files, 4 `docs-site/` pages and 83 mentions in `src/` comments.
- **Done when:** foottrace's suite is green with no footprintjs installed, and footprintjs's suite and byte fixtures are green on the branch against the foottrace candidate, with the fixtures unmodified.

### E4 — Publish foottrace 1.0.0

- **The owner** creates the npm trusted publisher (OIDC) for the new package. foottrace joins `scripts/family.json` as a published family package.
- **Nothing breaks:** nothing depends on foottrace yet.
- **The freeze.** From here until E6 the record code exists in two places. A CI check in footprintjs fails on any change to `RECORD_FILES`; a critical fix lands in both copies.

### E5 — Consumers move, each in a normal release

- **What each does.** Record symbols come from `foottrace` (named imports), and `footprintjs/write` becomes `foottrace/write`. The six `vi.mock`/`vi.doMock('footprintjs/trace')` sites are renamed, and each is shown to still bite: break the mock and its test fails.
- **Ranges.** Each adds `foottrace ^1.0.0` (a peer for the Lens, a dependency elsewhere). Each widens its footprintjs range to `<its 9.x floor> || ^10.0.0`. Before releasing, it runs its own checks with E3's footprintjs candidate installed (`npm install --no-save <tgz>`, as the audit does); E6's audit is the final check.
- **Order:** hcifootprint, agentfootprint, storyreel, the Lens, the playgrounds, vizfootprint (with the owner's go).
- **Done when:** no audited consumer's `main` imports a record symbol from footprintjs.

### E6 — footprintjs 10.0.0

- **The release.** `extract/foottrace` is rebased and merged. The audit runs every consumer's `main` against the 10.0.0 candidate. The CHANGELOG's "Breaks" section is the symbol map (7.5). The freeze is lifted.
- **After it,** foottrace's own consumer audit runs footprintjs and the family against every foottrace candidate. footprintjs is its first consumer.
- **Release:** footprintjs **10.0.0** (major), holding nothing but the extraction.

## 7. Extraction mechanics

### 7.1 Name and doors

- **The name:** `foottrace` (the owner's leaning, to be confirmed). "Trace" is the canon's word (Map · Walker · Trace · Fold · Lens). It was free on npm on 2026-10-08, as were `footrecord` and `foottrail`. `foottrail` stays reserved for vizfootprint's branching core.
- **`.` reads.** The readers and every record type: the fold, the cursor, the stops, the slices, the causal chain, the key queries, the id grammar, `HONESTY_CODES`, `UnknownVerbError`, `CommitRangeIndex`, `applySmartMerge`, `CommitBundle` and its family, `CommitValuesMode`, `EmitSourcePosition`, `LogAddress`.
- **`/write` writes.** `RecordFrame`, `SharedMemory`, `EventLog`, their option types, `WriteProvenanceMode`, and the log's placeholder.
- **`/testing`:** only if section 10 says yes.
- **Internals footprintjs needs.** R3 lists the record internals footprintjs's other layers use. Each one disappears in a C step, or E3's review publishes it on one of the two doors under a plain name.

### 7.2 Dependencies

- **foottrace:** `dependencies: {}`, `sideEffects: false`. It runs in a browser: it uses `structuredClone` and no `process` or `fs`.
- **footprintjs:** `"foottrace": "^1.0.0"` as an ordinary dependency. Its engine composes the record layer, and its public types refer to foottrace's types. This is footprintjs's first runtime dependency.
- **One installed copy.** Two copies would fail on class identity (`SharedMemory`, `EventLog`) and on `instanceof UnknownVerbError`. From E4, each audit job asserts that `npm ls foottrace` resolves to one version (`scripts/audit-consumers.mjs`).

### 7.3 One canonical door across packages

- **footprintjs re-exports nothing from foottrace,** whether type or value. `test/architecture/exports.test.ts` gains a rule: a footprintjs door may hand out only symbols declared inside footprintjs, so an alias whose declaration lies in foottrace fails. A footprintjs type may still refer to a foottrace type (`RuntimeSnapshot`'s commit log is `CommitBundle[]`), as long as a foottrace door hands that type out.
- **foottrace's own `exports.test.ts`** starts with two doors and an empty `SECOND_DOORS`.
- **The family follows the same rule.** hcifootprint's `src/index.ts` re-exports `CommitBundle` (`export type { CommitBundle } from 'footprintjs/advanced'`). That re-export goes in E5, and its CHANGELOG names it.

### 7.4 Versions and release order

- **foottrace starts at 1.0.0, not 0.x.** Its API has shipped in footprintjs since 9.17 and is pinned. A 0.x caret excludes the next minor; the family paid for that trap in June 2026, when a `^0.22.0` peer excluded 0.25.
- **foottrace's semver covers names and bytes,** under the fixtures' policy:
  - a refactor never re-pins;
  - a named law fix re-pins in a minor, listed under "Record bytes";
  - any other byte change is a major.
- **footprintjs takes a major, 10.0.0** (recommended). The consumers hold caret ranges on `origin/main`: agentfootprint peer `^9.44.1`, the Lens peer `^9.26.0`, hcifootprint `^9.44.1`, storyreel `^9.27.0`. A 9.x minor without the readers would break every one of them on a fresh install, which is the hcifootprint 2.6.0 failure across the whole family at once. A major lies outside those ranges.
- **Release order:** 9.44.2 (#62) → C1–C6 (six 9.x releases; hcifootprint 2.7.0 and an agentfootprint release ride in C5's train) → E1 and E2 (a Lens patch) → E3 → foottrace 1.0.0 → the consumers, one release each → footprintjs 10.0.0.

### 7.5 The symbol map and each consumer's move

**The rule:** a symbol moves to foottrace if, and only if, it is declared in a record file (`RECORD_FILES`, C6). This map fixes Appendix B of the first design: `CommitValuesMode` is on the main door, `WriteProvenanceMode` is on no door, `UntrackedSource` has two doors, and `/recorders` hands out `EmitSourcePosition` and `LogAddress`.

| Declared in | Today's door | After C5 | After E6 |
|---|---|---|---|
| `time-travel/*`, `slice/*`, `memory/{backtrack,commitLogUtils,honesty}.ts`, `ids/runtimeStageId.ts`, `recorder/CommitRangeIndex.ts`, `memory/verbs.ts` (`UnknownVerbError`), `memory/paths.ts` (`pathSegments`) | `/trace` (eight also on `/advanced`) | `/trace` | `foottrace` |
| `memory/types.ts`: `CommitBundle`, `TraceEntry`, `MemoryPatch`; `memory/verbs.ts`: `applySmartMerge` | `/advanced` | `/trace` | `foottrace` |
| `memory/types.ts`: `CommitPhase`, `UntrackedSource` | `/trace` (`UntrackedSource` also `/advanced`) | `/trace` | `foottrace` |
| `memory/types.ts`: `CommitValuesMode` | `.` | `.` | `foottrace` |
| `memory/eventPosition.ts`: `EmitSourcePosition`, `LogAddress` | `/recorders` | `/recorders` | `foottrace` |
| `SharedMemory`, `EventLog`, `RecordFrame`, `WriteProvenanceMode` | `/advanced`, or none | `/write` | `foottrace/write` |
| `TransactionBuffer`, `deepSmartMerge`, `getNestedValue`, `setNestedValue`, `updateNestedValue`, `updateValue`, `normalisePath`, `getRunAndGlobalPaths`, `redactPatch` | `/advanced` | none | none |
| `ids/branchSegment.ts`, the stores (`KeyedStore`, `SequenceStore`, `BoundaryStateStore`), the Topology, InOut, ControlDep and Quality recorders, `qualityTrace`, `ROOT_RUNTIME_STAGE_ID`, `ROOT_SUBFLOW_ID`, `walkSubflowSpec` | `/trace` | `/trace` | `footprintjs/trace`, unchanged |

| Consumer (`origin/main`, 2026-10-08) | What moves | Watch for |
|---|---|---|
| hcifootprint 2.6.1 | C5: the frame route → `/write`; four record symbols `/advanced` → `/trace`. E5: those, `sliceForKey`, `keysReadFromMap`, `formatSlice` (src) and `arrayProvenance`, `causalChain`, `commitValueAt`, `formatCausalChain` (tests) → `foottrace` | Drop its `CommitBundle` re-export. `evaluateFilter`, `FilterCondition` and `normalizeSchema` are not record symbols and stay on `/advanced` |
| agentfootprint 9.140.0 | C5: `CommitBundle`, `applySmartMerge` → `/trace`; `SharedMemory` (test helper) → `/write`. E5: 45 of its 51 `/trace` symbols, and `CommitValuesMode` (main door) → `foottrace`. The six stores, recorders and roots stay | `vi.mock('footprintjs/trace')` in `test/lib/time-travel/milestone-stops-contract.test.ts` and `served-view-complexity.test.ts`, and the example in `src/lib/time-travel/README.md` |
| agentfootprint-lens 0.72.1 | E2: named imports. E5: 21 of its 28 `/trace` symbols → `foottrace`. `KeyedStore`, `SequenceStore`, the Topology types, `walkSubflowSpec` and `WalkerItem` stay | `src/react/Lens.degraded-peer.test.tsx` and `test/context/firstSegment.test.ts` mock `'footprintjs/trace'`. Add a peer on foottrace |
| footprint-storyreel 0.11.0 | Tests only: `sliceForKey`, `keysReadFromExecutionTree`, `sliceToJSON`, `formatSlice` → `foottrace` | none |
| vizfootprint (unpublished) | `sliceForKey`, `keysReadFromExecutionTree`, `sliceToJSON` → `foottrace` | Paused by the owner; `vi.doMock` in `src/why/resolvers.coverage.test.ts` |
| footprint-playground, agent-playground | `src/runner/executeCode.ts` hands `footprintjs/trace` to user code as a namespace; it also hands `foottrace`, and the tutorials are updated | The namespace use is deliberate |

Outside the audit, four apps import `/trace` or `/advanced`: neo-agentfootprint (exact 9.27.0), neo-seo-local (9.44.0), agentfootprint-aasc-demo (9.43.0) and visible-reasoning (`^9.11.0`). They keep working on 9.x and move when they adopt 10.

## 8. The "ready to extract" check

E3 starts only when every row except the optional one is met. `scripts/trace-ready.mjs` (E1) prints this table in each release PR.

| # | Measure | Today | Ready when |
|---|---|---|---|
| R1 | L0–L3 files that import an L4+ file, by value or by type | 1: `memory/types.ts → memory/StageContext.ts` (type `ScopeFactory`) | 0 (C6) |
| R2 | Imports from a record file that land outside the record set (a mechanical move needs a closed set) | 5 on `main`, 6 with C1: `runtimeStageId.ts → branchSegment.ts`, `backtrack.ts → devMode.ts`, `types.ts → capture/policies.ts`, `capture/summarize.ts` and `StageContext.ts`, `recordCommit.ts → redaction.ts` | 0 (C4, C6) |
| R3 | Record internals that footprintjs's other layers import but no door hands out | 22 of 47 symbols, C1 branch: e.g. `recordCommit`, `ownSpine`, `LOG_PLACEHOLDER`, `refuseReservedId`, `stageIdOf`, `serveRecord` | 0, each gone (C3, C4, C6) or published on a foottrace door (E3) |
| R4 | Share of the record's test files that run without the engine | 28 of 80 (35%) | **≥ 70%**; the rest named as engine witnesses (E1) |
| R5 | Record symbols that audited consumers import from `/advanced`, and records written through the frame | hcifootprint 4 (and writes through `ExecutionRuntime`), agentfootprint 3 | 0 (C5) |
| R6 | Consumers that read a footprintjs door off a namespace | 2 sites in the Lens (the playgrounds are exempt) | 0 (E2) |
| opt | Commits touching a record file that also touch another `src` `.ts` file | 24 of 40 (60%) since 2026-07-08 | Optional: under 20% over 3 months |

**The co-change condition is optional; drop it.**

- **What it protects against.** A change that needs both packages ships as two releases.
- **Why it would hold the move back.** Every C step crosses the cut on purpose, so the number cannot fall below 20% until about three months after C6, which means early 2027.
- **Why dropping it is safe.** After C5 the seam is a public API (`/write`), so a cross-cut change is a visible API change with its own review. foottrace's audit also runs footprintjs's whole suite on every candidate. The cost of dropping it is an occasional extra release, not a risk.
- **What replaces it.** Print the number in each release PR for the first three months after E6, as information only.

## 9. Risks and how each is caught

| Risk | Caught by |
|---|---|
| A move silently changes a record byte | The byte fixtures stay unmodified in every C and E PR (gate 1); "a refactor never re-pins" |
| A consumer breaks | The consumer audit on every PR and before every tag; the `scripts/family.json` `branch` for same-train migrations; R5 |
| A symbol read off a namespace vanishes with no type error | The named-imports check (E2); R6 = 0 before E3 |
| A module mock silently stops applying after its import moves | The six sites listed in E5; each migrated mock is shown to still bite |
| A test-coverage gap: moved code tested only through the engine, or not at all | Each C step's reviewer checks the moved code's own tests (gate 6); R4 ≥ 70%; the engine witnesses keep running against foottrace |
| Two installed copies of foottrace | The audit asserts one copy per consumer (7.2) |
| An older published consumer, installed at an exact version, meets an `/advanced` change (C2, C3, C5) | Accepted by owner decision 4; the latest version of each consumer ships in the same train |
| A fix lands in only one copy during E4–E6 | The freeze check in footprintjs CI; the window is kept to days |
| Docs keep teaching the old door | E3's rewrite; `npm run test:examples` and `npm run check:doc-snippets` compile the code; a grep finds no moved symbol beside `footprintjs/trace` |

## 10. Owner decisions still open

1. **The name:** confirm `foottrace`. Recommend yes.
2. **footprintjs at extraction, major or minor:** recommend the major, 10.0.0. A minor breaks every published consumer whose caret admits it.
3. **The co-change condition:** recommend dropping it; print the number as information (section 8).
4. **A `/testing` kit:** recommend none at extraction. Add it as a foottrace minor when a producer writes records with its own code, such as viz's trail or a hand-built recording.
5. **The repository:** recommend its own repo, `footprintjs/foottrace` (the family stays polyrepo, ruling of 2026-06-22). You create the repo and its npm trusted publisher.
6. **vizfootprint's E5 change** (three symbols and one mock, while viz is paused): recommend allowing that one PR; otherwise viz leaves the audit for 10.0.0.
7. **The bytes policy** (`test/fixtures/README.md`, proposed as ruling 3): recommend adopting it as foottrace's promise, unchanged.

## Appendix — how the numbers were counted (2026-10-08)

- **R1:** every import, type-only ones included, from an L0–L3 file (per `layering.config.cjs · rankOf`) to an L4+ file, on `main` and on the C1 branch.
- **R2 and R3:** the record set is the 41 files of the "after" diagram as they stand on the C1 branch; C3 and C4 add `RecordFrame.ts` and `scrub.ts`. `RECORD_FILES` will hold that list. R2 counts imports out of the set. R3 counts symbols that non-record `src/lib` files import from it and that no door barrel names.
- **R4:** the 93 test files under `test/lib/{memory,slice,time-travel}`, minus the 13 that test code that stays: the frame, the run policy, the redaction verdict, diagnostics and the retention dials. A file is engine-free when no value import reaches `runner/`, `engine/`, `builder/`, `scope/`, `reactive/`, `StageContext`, the main or `/advanced` barrel, or a footprintjs package. `/trace` counts as its record part.
- **Consumers:** import statements parsed at each repository's `origin/main`, covering named imports, namespace imports, dynamic imports and `vi.mock` paths.
- **Co-change:** `git log` on `origin/main` since 2026-07-08. The review's narrower windows gave 66–77%.

E1 checks these scripts in, so the table is reproduced rather than retyped.
