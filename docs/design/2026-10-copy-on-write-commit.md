# Copy-on-write commit — a write costs what it writes, not what the state holds (design, 2026-10-01)

**Status:** BUILT for 9.29.0 — branch `feat/copy-on-write-commit` (the measured prototype, `design/copy-on-write-commit`
f5232f2, is its first commit). The decisions the build was made under, and everything the build changed or found
relative to the prototype, are in "The build" below; the sections between record the design as measured, corrected
where the build proved them wrong. Every number comes from an instrument named beside it — a checked-in bench or
test, or a scratch script listed under "Instruments"; nothing is estimated.

## The finding

An agent's state holds its growing conversation. The root-cause investigation of agentfootprint's flaky clock-run
test measured per-call CPU growing with the run whether or not anything changed — 11.6 / 26.5 / 39.6 / 91.6 ms at
provider calls 1 / 50 / 100 / 200 — because footprintjs deep-clones the WHOLE committed state three times for every
stage that writes: twice when the stage's `TransactionBuffer` is built (at its first write), once when its commit is
applied. About 90% of that state is `messagesInjections` + `history`.

At footprintjs level (`bench/commit-clones.ts`, counted, both `commitValues` encodings identical), a stage that
writes ONE number over a state holding a history of N items:

| N | `structuredClone` calls / stage | bytes cloned / stage | nodes visited / stage | CPU / stage (secondary) |
|---|---|---|---|---|
| 100 | 8 | 30.3 KB | 1,853 | 0.21 ms |
| 1,000 | 8 | 305.8 KB | 18,053 | 1.8 ms |
| 10,000 | 8 | 3.05 MB | 180,053 | 19.1 ms |

Three of the eight calls are the whole state (`TransactionBuffer` constructor: 2 calls, 2.03 MB at 10k;
`applySmartMerge`: 1 call, 1.02 MB). The other five are the written number (29 bytes in total). With a redaction
policy the redacted mirror adds a fourth whole-state clone (10 calls, 4.07 MB at 10k).

## The clone sites, and what each one protects

| Site (file · symbol) | Clones | Protects | Needed in full? |
|---|---|---|---|
| `TransactionBuffer` · constructor → `baseSnapshot` | whole state, at the stage's first write | the net-change diff base must not move during the stage | **No.** The base IS the committed generation the stage first touched, and committed state is immutable-after-swap — the invariant `StageContext · firstTouchState` has rested on since #13. A reference is exactly as stable. |
| `TransactionBuffer` · constructor → `workingCopy` | whole state, at the stage's first write | the buffer writes `nativeSet` INTO it, and committed state must not be written; read-your-writes | **Only the written paths.** The buffer writes along each op's path and nowhere else. |
| `utils` · `applySmartMerge` | whole state, per commit | immutable-after-swap: in-flight first-touch views and buffer bases hold the previous generation | **Only the written paths.** The replay writes along each trace row's path and nowhere else. |
| same, via the redacted mirror's `SharedMemory` · `applyPatch` | whole mirror, per commit (policy only) | the same, for the served mirror | Same as above — free once the replay copies paths. |
| `TransactionBuffer` · `replayFamilyVerbs` | the family root's base value (delta mode, overlapping paths) | the box replays in place | **No** under path copying (it copies its own path). |
| `TransactionBuffer` · `toChangeOnlyPayload` / `toDeltaPayload` | each surviving written value, once | the record never aliases a caller's object (9.23.0) | Yes — value-sized, kept. |
| `utils` · `applySmartMergeInto` set / append arms | the recorded value, per row | live state, the mirror and the folds never alias the payload or the log | Yes — value-sized, kept. |
| `utils` · `redactPatch` | the bundle's patches, per commit, even with no policy | the log never aliases what the live replay consumed | Kept (value-sized; see residual R2). |
| `StageContext` · `retainedForm` | each tracked read / write value | the execution tree's `stageReads` / `stageWrites` | Dial-governed (`readTracking` / `writeTracking`); kept (residual R1). |
| `TransactionBuffer` · `detachHeldAncestors` | a held caller value, on the engine's nested-op path | 9.23.0's `set a; merge a.b` detach | Yes — kept untouched. |
| `EventLog` · constructor / `getInitialState`; pause checkpoint; resume clone-in; dev-mode `getSnapshot` frozen clone; `$batchArray` | once per runtime / per call | detached fold base, checkpoint, caller isolation | Yes — not per stage, untouched. |

## The law

**A committed generation is never edited. A commit builds the next generation by copying the root and every
container on each written path; every other subtree is SHARED with the generation before it. A writer edits in
place only containers it created during the current operation.**

It is the law `reactive/structuralWrite.ts · setInPath` already applies to a single value ("copies the containers
along the path (and only those) and returns a new root, leaving every untouched sibling shared by reference"),
extended to the whole state, so the commit path and the proxy write path now follow ONE rule.

Its consequence, stated as a law of its own: **a write changes exactly its own path** (value semantics). Two
positions that happen to hold the same container are two values; a write through one does not reach the other.
(See M3 — that is what a JSON round trip, e.g. a persisted checkpoint, already did.)

## The change, per file · symbol (all in the prototype)

- `memory/pathOps.ts` — four primitives: `shallowCopy` (one container; keeps a plain object's own keys in order via
  spread, an array's indices, holes, length AND named properties — `structuredClone` keeps those; deep-clones a
  `Date`/`Map`/`Set`/typed array/class instance, exactly what the whole-state clone did to it), `ownSpine` (walk to
  a path's leaf, replace every container the writer did not create with its shallow copy; stops where `nativeSet`
  stops or creates), `ownedRootOf`, `own`. O(depth × width) per written path; a root-key write (the common case)
  copies nothing beyond the root.
- `memory/utils.ts` — `applySmartMerge` and `applySmartMergeInto` share ONE loop, `replayRows` — the replay's verb
  switch, unchanged except: `ownSpine` before the switch (one line), every value an arm creates is marked owned, and
  the merge arm reads a once-per-replay detached copy of `updates` (D2). The ownership set is allocated only for a
  bundle that has a nested row (`hasNestedRow`) — a bundle of root-key rows, the typed scope's only kind, allocates
  nothing beyond the root copy. `applySmartMerge` starts from a shallow root copy instead of
  `structuredClone(base)`; `applySmartMergeInto` mutates its caller's private root in place as before and copies
  below it, so the folds follow the live law. No fifth replica: `commitValueAt`, `TransactionBuffer ·
  toDeltaPayload` and `replayPathVerbs` write nothing in place and are untouched; `replayFamilyVerbs` gains the same
  `ownSpine` line (and drops its whole-subtree clone); `supersededByNextSet` is asked BEFORE the spine copy, so a
  skipped row copies nothing.
- `memory/TransactionBuffer.ts` — constructor: `baseSnapshot = base` (reference), `workingCopy = ownedRootOf(base)`;
  `set` / `delete` / `merge` call `ownSpine` before writing the working copy (merge marks its result owned).
  **Private reads (option D, recommended):** after the stage's first write, the first READ of a container the
  working copy still shares with the committed generation replaces it with a private deep copy (`privatise`) —
  what the whole-state clone gave every post-write read; see M1/M2. "Shares" is positional (`=== base at the same
  path`), so a caller's own staged object is never copied (`$setValue(k, o); $getValue(k) === o` still holds). Two
  details for the build: mark the private copy's whole subtree owned (the prototype marks its top only, so a later
  engine nested write through it shallow-copies once more — harmless, value-equal), and let
  `StageContext · warnOnBorrowedMutation` read the buffer without privatising (it is a dev-mode report, not a read).
- `memory/SharedMemory.ts` — the seed is detached ONCE at construction (`mergeContextWins` copies only the top
  level; the first commit's whole-state clone used to detach the rest); `applyPatch` swaps in the path-copied
  generation; the two public in-place mutators `setValue` / `updateValue` path-copy and swap too, so immutable-after-
  swap holds even for direct callers (no engine caller exists).
- `engine/handlers/SubflowExecutor.ts` — `detachMappedInput`: the mapped input's plain objects and arrays are
  cloned ONCE per mount before they become the subflow's frozen args (D1).
- `memory/StageContext.ts` — comments only ("2 full-state clones" → path copies; `firstTouchState` now also names
  the buffer's diff base as resting on immutable-after-swap).
- Untouched: `StageContext.commit`'s flow and order, `redactPatch`, the redaction rule, `EventLog`, the payload
  encoders, `commitValueAt`, checkpoint build / resume, every handler, the reactive layer.

## Invariants — kept, and how

| Invariant / landmine | Under copy-on-write |
|---|---|
| Committed state immutable-after-swap | Kept by construction: no writer edits a container it did not create. Measured: the full suite with EVERY committed generation `Object.freeze`d (census below) — 0 throws from `src/lib` in 4,443 tests. Property-pinned: every generation a stage saw equals, at the end of the run, the copy taken when it was seen. |
| First-touch views hold bare references | Unchanged — generations are never edited, so a view and now the buffer's diff base stay exact. |
| Clone once at commit (9.23.0, landmine 3 first bite) | Unchanged: the patch trees still hold references; the payload is cloned once per surviving path at the boundary. |
| `detachHeldAncestors` | Unchanged for `overwritePatch`. The working copy now copies a held caller value before an engine nested op writes through it, instead of editing the caller's object (a 9.23.0 wart; log bytes unchanged). |
| Redaction one law (9.19.0) | Unchanged: the mirror replays the redacted patches through the same path-copying replay; nothing new retains or serves a value. The served mirror no longer shares containers with the log (D2). |
| Delta mode / `EventLog.materialise` / `commitValueAt` | Byte-identical in both encodings (differential + reference suites). `materialise` inherits path copying (side effect: no per-step whole-state clone). |
| `supersededByNextSet` (consecutive-only skip) | Unchanged; asked before any copy. |
| Four verb replicas in lockstep | Unchanged verbs; one added line before the replay switch and in `replayFamilyVerbs`. |
| Subflow isolation (fresh runtime + mappers) | Unchanged: the seed is staged and cloned at its commit, never shared with the parent. The mapped input is detached before it is frozen (D1). |
| Pause checkpoint — one detached `structuredClone` | Unchanged (a clone of a shared tree is a whole tree). |
| Commit log bytes | Byte-identical, both encodings (6,000-program differential, reference suites, agentfootprint digests). |
| Dev-mode frozen `getSnapshot` clone | Unchanged (see risks: why the live state cannot be frozen instead, yet). |
| Landmine 1 (assigned value only) / landmine 4 (deep writes, borrowed-mutation warning) | Their suites pass unchanged; the warning still fires (M2). |

## What moves — named, each pinned

With option D, the out-of-contract borrowed-mutation patterns behave exactly as in 9.28.0; without it, M1 and M2
move. The rest move either way.

- **M1 (only without D)** — a borrowed read mutated IN PLACE after the stage's first write, then written back as
  the same object (`s.other = 1; const c = s.$getValue('cfg'); c.x = 99; s.$setValue('cfg', c)`): 9.28.0 records
  `cfg`; pure copy-on-write records NO change (base and value are the same object), live state holds `x: 99`, the
  fold disagrees, and no warning fires. The same pattern BEFORE the first write already drops the change in 9.28.0
  (control M1b). Option D restores 9.28.0 exactly.
- **M2 (only without D)** — a borrowed element mutated in place after the first write and not written back: 9.28.0
  contains it in the private clone (lost silently, state untouched); pure copy-on-write edits committed state with
  no row. Both warn in dev mode. Option D restores 9.28.0 exactly.
- **M3** — aliased committed state (`initialContext: { a: o, b: o }`) + a nested write through `a` (an
  `outputMapper` plain-object merge): 9.28.0 changes `b` too; copy-on-write changes `a` only (value semantics).
  Reachable only through the engine's nested-path doors (subflow seed, merge-back, `/zod`), never through the
  typed scope, which writes root keys.
- **M4** — a class instance in `initialContext` is a plain object from the FIRST stage on (9.28.0: from the first
  commit on — before it, stages saw the caller's instance). Caused by the one-time seed detach.
- **M5 (fix)** — the caller's `initialContext` objects are detached at construction. 9.28.0 shared them until the
  first commit: a caller mutating its seed object before then changes live state with no row, and the fold
  disagrees (`seed.cfg.n = 42` in the first stage → 9.28.0 live `cfg.n` 42, fold 1; prototype 1 and 1).
- **M6 (fix)** — expando properties a nested engine write hangs on a committed `Date`/`Map`/`Set` (`setObject(['when'],
  'y', …)` over a `Date`): 9.28.0's next whole-state clone silently drops them from LIVE state while its fold keeps
  them (fold ≠ live — found by the differential); copy-on-write keeps them in both.
- **D1 (fix of a 9.28.0 bug that copy-on-write would widen)** — `readonlyInput · createFrozenArgs` deep-freezes a
  subflow's args IN PLACE, and an `inputMapper` that passes a parent object through (`(p) => ({ cfg: p.cfg })`)
  hands it the parent's committed object. The typed scope does not proxy frozen values
  (`allowlist · shouldWrapWithProxy`), so a later `scope.cfg.x = 1` in the parent meets the raw frozen object:
  TypeError in strict code. 9.28.0 hides this only until the parent's next non-empty commit re-clones the state —
  reproduced on 9.28.0 with a mount that commits nothing (the pin is red on stock). Under copy-on-write nothing
  re-clones, so the frozen object would stay for as long as the key is not rewritten (the differential found it
  within 19 programs). Fixed by detaching the mapped input once per mount.
- **D2 (fix)** — the replay's merge arm placed a merge delta's array ELEMENTS by reference, and the mirror and the
  folds replay the LOG's own `updates` — 9.28.0's served mirror shares containers with the log until its next
  whole-state clone (57 and 78 of 3,000 differential programs end that way). The replay now detaches `updates`
  once per bundle — once, not per row: two merge rows of one bundle replay the same accumulated delta, and
  `deepSmartMerge`'s array union dedups BY REFERENCE (a per-row copy duplicated elements; the differential caught it).

## Measured — before (9.28.0) vs prototype

**footprintjs, `bench/commit-clones.ts`** (counts identical in both encodings; CPU on a machine at load 55–465):

| scenario, per stage | N | 9.28.0 clones · bytes · nodes | prototype clones · bytes · nodes · path copies |
|---|---|---|---|
| write one number | 100 | 8 · 30.3 KB · 1,853 | 5 · 29 B · 6 · 2 (25 slots) |
| write one number | 1,000 | 8 · 305.8 KB · 18,053 | 5 · 29 B · 6 · 2 (25 slots) |
| write one number | 10,000 | 8 · 3.05 MB · 180,053 | 5 · 29 B · 6 · 2 (25 slots) |
| same, redacted mirror on | 10,000 | 10 · 4.07 MB · 240,069 | 6 · 33 B · 7 · 3 (38 slots) |
| write one number, then read `history` (tracked) | 10,000 | 9 · 4.07 MB | 6 · 1.02 MB (option D: 7 · 2.03 MB) |
| same, `readTracking: 'off'` | 10,000 | 8 · 3.05 MB | 5 · 29 B (option D: 6 · 1.02 MB) |
| agent turn (push to `history`, write a number, read `history`), full | 10,000 | 18 · 12.21 MB | 12 · 6.10 MB |
| agent turn, delta | 10,000 | 18 · 9.16 MB | 12 · 3.05 MB |

CPU per one-number stage: 0.21 / 1.8 / 19.1 ms → 0.022–0.036 ms flat across N.

**agentfootprint clock-run scenario** (`agent-probe`, N = 200 provider calls, armed, the prototype's build dropped in
for `footprintjs`):

| engine | clones / call @200 | MB / call @200 | clones, whole run | MB, whole run |
|---|---|---|---|---|
| 9.28.0 | 250 | 37.38 | 50,456 | 3,792 |
| prototype | 204 | 9.17 | 41,215 | 932 |
| prototype + option D | 209 | 9.27 | 42,216 | 942 |

Digests (shared state, commit log, findings ledger) equal 9.28.0's at N = 50 and 200, plain and armed, with and
without option D. Option D's private copies are 1% of the remaining bytes (1,001 calls, 9.7 MB per run); the D1
mount detach is 13.8% (2,831 calls, 129 MB).

CPU (secondary — measured at load average 111–478 on an 18-core machine shared with other sessions; the runs were
interleaved stock / prototype / prototype + D so each triple saw the same load, and the PAIRED ratio is the number
to quote):

| N | 9.28.0 run CPU (median) | prototype | + option D | paired 9.28.0 ÷ prototype | ÷ prototype + D | per-call CPU at the last call: 9.28.0 → prototype (+ D) |
|---|---|---|---|---|---|---|
| 50 (n = 3) | 1,306 ms | 766 ms | 793 ms | 1.71× | 1.65× | 38.6 → 19.9 (21.2) ms |
| 100 (n = 3) | 4,014 ms | 2,103 ms | 2,111 ms | 1.93× | 1.90× | 63.4 → 26.1 (26.6) ms |
| 200 (n = 5) | 15,885 ms | 7,201 ms | 7,251 ms | 2.28× (2.03–2.34) | 2.19× (1.99–2.54) | 163.7 → 69.7 (66.2) ms |

Heap after GC at N = 200: 1,029 MB → 852 MB (875 MB with D). The per-call CPU still grows (19 → 70 ms) — that is
the residual below (the written conversation is still copied three times per write in `'full'` mode, and every
tracked read of it is retained), not the commit.

**The other instruments, before vs prototype.** `bench/element-writes.ts` (9.23.0's): equal or faster at every row
(10k element writes, full: 238 → 223 ms; delta: 253 → 147 ms; `$batchArray` 57 → 47 / 96 → 41 ms).
`bench/time-travel.ts` (the read side, N = 2,000, three interleaved rounds): `stateAt(last)` 504 → 542 µs, one step
807 → 938 µs — while `timeTravel()`, code this design does not touch, moved 553 → 850 µs: that is the noise floor at
this load, and no read-side change is measurable. Counted instead: a fold step over a root-key bundle does one
O(rows) path scan more and allocates nothing more.

**Byte identity.** A stock-vs-prototype differential (fast-check; programs written through the typed scope —
sets, nested sets, pushes, element writes, `$update`, deletes, write-then-revert, rewrite-the-same-object,
`$batchArray` — plus a subflow whose plain-object seed and merge-back produce NESTED rows, and a fork; random
`commitValues`, `readTracking`, redaction policy, `initialContext`) compares the commit log, live state, redacted
mirror, subflow results (plain and redacted), execution tree, the fold at every stop, and every error: 6,000
programs over two seeds identical, and 3,000 more with option D on, identical. Its counterexamples were M6, D1 and
the per-row-clone bug of D2 — each found, understood, then fixed or named above. The prototype's served state
shares no container with the log in any program. With option D on, the moved-behaviour probe reproduces 9.28.0
exactly for M1 and M2 (same rows, same state, fold === live, the same dev-mode warning).

**Full suite** (4,443 tests on 9.28.0; 4,453 with the 10 new tests), run with and without option D: one real
change of status — `repeated-path-skips` pins "the base, then the value — 2 clones" for one replay; it is 1 now (the
base clone is the thing removed). Two wall-clock tests failed once each while a differential ran beside them at load
≈ 400 (`decide/unit/evaluator` "scales linearly", `reactive/unit/pathBuilder` "under 20ms"); both pass alone on
both trees. ESM packaging passes against the prototype's `dist`. The 10 new tests: 10/10 green on the prototype;
on 9.28.0 the complexity guard (4/4), D1, D2 (2/2) and M3 are red, the generations property and "args still
frozen" green.

**Census — could dev mode freeze committed state?** The full suite with EVERY committed generation frozen (a
prototype-only switch): 83 failures in 14 files. 81 are thrown in test-authored stage code at a typed-scope write —
almost all in-contract (`scope.tags.push('vip')`, `scope.customer.address.zip = '10001'`), because the typed scope
refuses to proxy a frozen value and hands back the raw one; one is the held-handle refusal test, which now meets the
frozen object first. The other two are a test asserting production state is NOT frozen and the clone-count pin.
None is thrown in `src/lib`. So the engine never writes into a committed container, and a freeze-based dev guard
is not possible until the reactive layer can proxy frozen values (risk R3).

## Test plan

1. **Byte identity, pinned.** The three existing reference suites (`repeated-path-byte-identity`,
   `declared-tags-byte-identity`, `redaction-no-policy`) unchanged, plus a new reference corpus: the differential's
   generator at fixed seeds, outputs (log, state, mirror, folds, subflow results — both encodings) generated on the
   9.28.0 tag and checked in, regenerated only on the old tag (the repeated-path convention).
2. **Byte identity, generative.** The stock-vs-new differential as a release-gate script (not `npm test`): the
   previous published version as an aliased devDependency, 6,000 programs.
3. **Complexity guard, counted.** `test/lib/memory/boundary/commit-cost-independent-of-state.test.ts` (in the
   prototype): per one-number stage, `structuredClone` calls and nodes are IDENTICAL at N = 100 and 10,000, both
   encodings, with and without a mirror, and under 20 nodes. Red on 9.28.0 (4/4), green on the prototype. Never a
   wall-clock budget.
4. **The law, as a property.** `copy-on-write-commit.test.ts` (in the prototype): every generation a stage saw is
   unchanged at the end of the run (fast-check, 150 runs) — green on both trees; it guards the implementation.
5. **Each moved behaviour and fix, by name** (same file): D1 (red on 9.28.0 — `Cannot assign to read only property
   'x'`), D1's args stay frozen, D2 (red on 9.28.0), M3 (red on 9.28.0). To add: M1/M2 equal to 9.28.0 under option
   D, M4, M6 (fold === live), and the borrowed-mutation warning still firing for M2.
6. **Landmines re-run unchanged:** `assigned-value-only` (L1), `clone-once-at-commit` (L3), `deep-writes-through-
   arrays` and the borrowed-mutation suites (L4), `lazy-buffer` (read-only stages still clone nothing; a read-only
   typed stage still costs exactly its tracked-read clone), `commit-release`, the redaction suites, the resume
   suites.
7. **Moved pin:** `repeated-path-skips` "clones once" 2 → 1, with the reason in the test.
8. **Family gate before release:** agentfootprint, neo and the lens suites against the build, dev mode on; any
   borrowed-mutation warning is a finding, not noise.

## Rollout

A minor (9.29.0). **No dial**, for the reason the fold guide gives: a dial is for an operator's memory-against-time
trade, and this is not one — copy-on-write uses LESS memory as well as less time (generations share structure), and
for every in-contract program it changes no byte. Two implementations of "immutable after swap" would be two laws
about the same bytes, which the family's rule (one owner of the law) does not allow. The moved behaviours are
named in the CHANGELOG with their examples; M3 and M4 are the only ones a working program can observe.

Docs: `memory/README.md` design-table row (what / why / consequence, the law, the census); CLAUDE.md "Core state &
flow" (`applySmartMerge clones+swaps` → `path-copies + swaps`), the invariant line on first-touch views, landmine 3's
second bite (the borrowed value is the committed object itself, before AND after the first write, unless D);
the fold guide gains §9 "copy-on-write commit" with the bench table.

## Risks

- **R1 — M1/M2 without option D.** Pure copy-on-write turns the post-first-write case of an out-of-contract
  pattern from "works by accident" into a silently dropped write. Mitigated in full by option D at a measured 1%
  of bytes; that is why D is part of the recommendation, not an alternative.
- **R2 — D1's cost and its proper fix.** The mount detach is 13.8% of the remaining clone bytes in the agent
  scenario (each mount copies what the mapper passes through, e.g. the conversation). The proper fix removes it:
  let the reactive layer proxy frozen values (a shadow proxy target; every proxy write is already structural), so a
  frozen committed object stays writable through the scope and the args freeze can stay in place.
- **R3 — no freeze-based dev guard yet.** Same prerequisite as R2 (census: 83 in-contract failures otherwise). Until
  then the borrowed-mutation warning is the dev-mode report, and it still fires.
- **R4 — CLOSED by decision 3.** (As measured:) **`applySmartMerge` and `SharedMemory` are exported** (`/advanced`). `applySmartMerge`'s result now shares
  unchanged subtrees with its base. The one family caller, agentfootprint's `time-travel/keyedFold.ts`, replays a
  FROZEN per-key value through it and freezes the result — it works under the prototype (nothing frozen is written
  into) and stops paying a deep clone per step. Still, keep the exported contract (a detached result) and route the
  engine through an internal sharing function, or document the sharing — the build must choose; the prototype
  shares. Also: its merge arm now clones a bundle's `updates` once, so a hand-built bundle holding an uncloneable
  value there throws (out of contract — state values survive `structuredClone`). hcifootprint builds a
  `SharedMemory` from an already-cloned seed and commits through `StageContext` — it inherits the gain; the
  constructor detach costs it one redundant clone per session.
- **R5 — width, not size.** A write still copies each container on its path in full: a root with thousands of keys
  (or a `runs` container with hundreds of fork children) costs that many slots per commit. Measured worst case — a
  linear chart whose every stage writes a NEW root key (the `bench/time-travel.ts` shape): 1,000 stages 231 → 214
  ms, 10,000 stages 55.9 s → 27.2 s (9,999 slots copied per stage). Never worse than 9.28.0, which deep-cloned
  that same root three times per stage, but still quadratic for a state that keeps adding ROOT keys; an agent's
  state has tens. A persistent map at the root would remove it — not proposed.
- **R6 — identity.** A value read after another stage's commit may now be the SAME object the earlier stage read
  (shared, unchanged). Nothing in the library compares identity across stages; a consumer that did would see more
  sharing, never different values.

## Residuals (not this design)

- **Read / write tracking retention** (`StageContext · retainedForm`): with `readTracking` / `writeTracking` at
  `'full'`, every tracked read and write of the conversation is still cloned — the largest residual in the agent
  turn (3.05 MB of 6.10 MB at 10k). Already a dial.
- **Three copies of every written value** (payload, replay set arm, `redactPatch` for the log): the remaining
  per-write cost in `'full'` mode when an agent re-sets a growing array; `'delta'` already stores only the tail.
  Sharing ONE frozen copy between log and state needs the same frozen-value support as R2.

## Recommendation

Build, with conditions: (1) option D in, by default, no dial; (2) the D1 mount detach in (it fixes a 9.28.0 bug);
(3) the D2 once-per-bundle delta detach in; (4) a decision on R4 before the PR; (5) the test plan's items 1, 3, 4,
5 and 8 green before release. Follow-up packet: shadow-target proxies for frozen values (removes R2's cost, unlocks
R3's dev guard and the residual's shared copy).

The prototype's switches — `FP_COW_PRIVATE_READS` (option D), `FP_COW_FREEZE` (the census), `FP_COW_DETACH` (an
attribution switch) — and the `__fpPathCopyStats` counter are instruments, not design: the build removes them and
makes option D unconditional.

## The build (2026-10-01)

### Decisions (main session — library-correct; recorded here as made)

1. **Option D on by default, no setting.** A stage's first read of a container still shared with committed state,
   after its first write, returns a private deep copy — 9.28.0's observable behaviour for in-place mutation (M1/M2)
   is preserved exactly. The prototype's `FP_COW_PRIVATE_READS` switch is gone.
2. **D1 and D2 in.** The mapped subflow input is copied once per mount (an inputMapper passing a parent object
   through never freezes the parent's object; its own regression test reproduces the 9.28.0 TypeError on the real
   9.28.0). The redacted mirror never shares objects with the log; the replay detaches a bundle's `updates` once
   per replay, not per row.
3. **The EXPORTED `applySmartMerge` keeps its public contract** — a fully detached result, byte-identical to 9.28.0
   for every caller, aliasing included (risk R4 closed). The engine commits through an internal path-copying
   variant, `utils · nextGeneration`. One owner of the verb switch: `utils · replayRows`, behind all three — the
   public function is the detach (a deep clone of the base) plus `replayRows` editing that private clone in place;
   `nextGeneration` is a root copy plus `replayRows` path-copying; the folds' `applySmartMergeInto` is the caller's
   private copy plus `replayRows` path-copying. No fifth replica. (`repeated-path-skips` therefore keeps its 9.28.0
   pin of 2 clones — the prototype's moved pin is reverted.)
4. **M3–M6 named in the CHANGELOG** under "Changed", one example each; the README / CLAUDE.md invariant lines
   updated, citing file · symbol.

### What the build changed relative to the prototype

- **Instruments removed:** `FP_COW_FREEZE` + `pathOps · freezeNew` (the census), `FP_COW_DETACH`, the
  `__fpPathCopyStats` counter (the bench's path-copy columns went with it; `structuredClone` calls, bytes and nodes
  remain its counts).
- **Private reads, made robust** (`TransactionBuffer · privatise`), beyond the prototype's top-of-path copy:
  - a value the stage STAGED (`set`) is handed back by reference and never privatised, even when it is the very
    object committed state holds at that path (a write-back): a private copy would leave `workingCopy` and
    `overwritePatch` disagreeing — the prototype recorded a phantom `set` of the OLD value in that case;
  - a shared container ON THE WAY to the value read is copied shallowly, only the value read deeply (a read of
    `runs/<id>/k` copies `k`, not every fork child's namespace — the prototype deep-copied the first shared
    container, `runs` itself);
  - a read that lands on an OWNED container (a path copy a nested write made, a merge result) privatises the
    shared containers below it, once (`privatiseBelow`, `privateTrees`) — the prototype handed out an owned shallow
    copy whose children were committed state (reachable through `/zod` and the nested engine doors);
  - the private copy's whole subtree is owned (`pathOps · adopt`), so a later nested write edits it in place, as
    the private clone was edited before;
  - a read resolves its path first and copies nothing for a path that lands on nothing (a refused segment, a
    missing key);
  - `peek` reads without privatising, and `StageContext · warnOnBorrowedMutation` uses it (a report compares).
- **A merge privatises its base first** (`TransactionBuffer · merge`). Required for BYTE identity, not only for
  option D: `deepSmartMerge` unions arrays by reference, so `$update(k, [elementReadFromK])` dedups the element
  against a committed array and appends it to a private copy. The build's differential found the prototype
  diverging from 9.28.0 on in-contract programs here (and on the same op through a read after the first write
  without option D): mutation-tested — removing either line fails the chart property.
- **`shallowCopy`:** an array with a hole AND a named property lost the property (the prototype detected names by
  `Object.keys(a).length !== a.length`, which a hole cancels; now: names are the tail of own-key order, with an
  exact array-index test); a null-prototype object copies to an ordinary one (what `structuredClone` made of it);
  a `Date`/`Map`/`Set` keeps the expandos the clone drops, so a later write through it changes exactly its own path
  (M6 holds after a second write, not only the first).
- **`EventLog.materialise`** folds with `applySmartMergeInto` over one private clone (it called the public
  `applySmartMerge`, which keeps the 9.28.0 aliasing semantics and a clone per step); every fold now follows the
  live law.
- **D1 extended** to `Date`, `Map` and `Set` mapped values (`SubflowExecutor · isDetachable`): freezing is an edit,
  and a mount must not edit the parent's committed objects. Class instances still pass by reference.
- **A dev-mode report for M7** (`StageContext · warnOnCommittedMutation`, `borrowedMutation ·
  committedMutationMessage`) — see M7 below. Production pays nothing (`isDevMode()` + `readTracking: 'full'`).

### Two more named behaviours the build's differential found

- **M7 — a value read BEFORE the stage's first write, mutated in place AFTER it, then written back** (`c =
  $getValue('cfg'); s.other = 1; c.x = 99; $setValue('cfg', c)`): 9.28.0 recorded `x: 99` — by accident, its diff
  base was a clone taken at the first write, between the read and the edit. Now the diff base IS the committed
  object the edit also moved, so the commit records no change: live state keeps the edit, the log and the fold do
  not. Option D cannot cover it (the read happened before the buffer existed); restoring it would mean cloning
  every container a stage reads before its first write — the in-contract typed-scope push pays that. Out of
  contract (reads are borrowed) and now LOUD: dev mode warns for a written key whose last read came from committed
  state when that committed object changed in place (which also catches M1b, dropped silently by 9.28.0 and now).
- **M8 — a nested write through a value the same stage `set`** (`/zod` or `StageContext`: `setObject(['obj'],
  'deep', o)` then `setObject(['obj','deep'], 'x', 2)`): 9.28.0 edited the caller's `o` in place, so the outer
  key's retained `stageWrites` entry (and the `onCommit` payload) showed the inner write too. Now `o` is copied
  first and stays as written; the inner write is its own entry. Commit log, state and folds byte-identical. The
  typed scope never takes this path (it writes root keys).

### Measured on the build

`bench/commit-clones.ts --src <tree>`, 9.28.0's `src` vs the build's, two interleaved rounds (load average 120–200 on
an 18-core machine shared with other sessions). Counts are identical in both rounds and both encodings; CPU is the
secondary signal.

| per stage, N-item history | N | 9.28.0 clones · bytes · nodes | build clones · bytes · nodes |
|---|---|---|---|
| write one number | 100 | 8 · 30.3 KB · 1,853 | 5 · 29 B · 6 |
| write one number | 10,000 | 8 · 3.05 MB · 180,053 | 5 · 29 B · 6 |
| same, redacted mirror on | 10,000 | 10 · 4.07 MB · 240,069 | 6 · 33 B · 7 |
| write a number, read the history (tracked) | 10,000 | 9 · 4.07 MB | 7 · 2.03 MB |
| same, `readTracking: 'off'` | 10,000 | 8 · 3.05 MB | 6 · 1.02 MB |
| agent turn, `'full'` / `'delta'` | 10,000 | 18 · 12.21 MB / 18 · 9.16 MB | 12 · 6.10 MB / 12 · 3.05 MB |
| CPU per one-number stage (rounds 1 / 2) | 100 · 1k · 10k | 0.20 · 1.8 · 18.7 / 0.20 · 1.9 · 20.1 ms | 0.019 · 0.019 · 0.018 / 0.019 · 0.018 · 0.019 ms |

The read-after-write rows carry option D's private copy (the value read, once); the prototype's numbers without D
were 6 · 1.02 MB and 5 · 29 B. The agent row matches the prototype: its push is the stage's first write.

Secondary, same load: `bench/element-writes.ts` (published 9.28.0 `dist` vs the build's), 10,000 element writes,
two rounds — `'full'` loop 172 / 206 → 144 / 156 ms, `'delta'` loop 205 / 220 → 148 / 173 ms, `$batchArray` 67 / 50
→ 39 / 58 ms and 49 / 47 → 36 / 42 ms. `bench/time-travel.ts` (10,000 commits, each a new root key — risk R5's
shape): build + run 37.8 / 37.7 s → 21.3 / 21.9 s; the read side within noise (`stateAt(last)` 3.85 / 4.05 →
4.13 / 3.85 ms, one step 7.22 / 7.72 → 8.68 / 6.57 ms).

### Test plan — as built

| Item | File | Status |
|---|---|---|
| 1. Byte identity, pinned | `test/lib/memory/scenario/copy-on-write-byte-identity.test.ts` + `reference/copy-on-write-9.28.0.json` (280 programs, three families, run on the published 9.28.0, a digest per kept field) and the three existing reference suites, unchanged | green |
| 2. Byte identity, generative | `test/lib/memory/property/copy-on-write-differential.property.test.ts` — the published 9.28.0 (`footprintjs-baseline`, pinned exactly, out of Renovate) vs `src`, fixed seeds; chart / borrowed / nested families; `COW_DIFF_RUNS=6000` for the release gate | green (150 / 150 / 400 runs in `npm test`) |
| 3. Complexity guard, counted | `test/lib/memory/boundary/commit-cost-independent-of-state.test.ts` (7: one-number stage × encodings × mirror, a fork child's namespaced write, a subflow's nested merge-back, a read after the first write pays for the value read) and `copy-on-write.load.test.ts` (400 commits; an agent loop) | green; all red on 9.28.0 |
| 4. The law, as a property | `copy-on-write-commit.test.ts` (every generation a stage saw, live and mirror, unchanged at the end) + the differential's per-program generation check | green |
| 5. Each named behaviour | `copy-on-write-commit.test.ts` — D1 (9.28.0's TypeError reproduced on the real 9.28.0), D2, M1, M1b, M2 (+ the merge variant), M3–M8, each against the real 9.28.0 | green |
| 6. Landmines re-run | the full suite, unchanged | green |
| Unit / security | `unit/copy-on-write.test.ts` (primitives, the three replays, private reads, generations); `security/copy-on-write.security.test.ts` (hostile paths through every replay and read; an own `__proto__` key; served views never reach the record) | green |

## Instruments (where every number came from)

- In the prototype: `bench/commit-clones.ts` (counts by call site, `--src <tree>` measures another tree);
  `test/lib/memory/boundary/commit-cost-independent-of-state.test.ts`; `test/lib/memory/scenario/
  copy-on-write-commit.test.ts`.
- Scratch, alongside the worktree (`…/scratchpad/cow-tools/`): `cow-differential.ts` (stock vs prototype, fast-check,
  imports both trees' `src`), `cow-moved.ts` (M1–M5 on both trees), `m5.ts`, `wide-root.ts`; raw outputs in
  `…/scratchpad/cow-results/`. The agentfootprint numbers come from the clock-run investigation's `agent-probe`
  bundle with `footprintjs` resolved to the prototype's `dist` (`…/scratchpad/af-cow/`).
