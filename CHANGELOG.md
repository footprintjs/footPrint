# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [9.25.0] - 2026-09-16

### Changed — the read-side fold clones once, and a cursor steps by one bundle

- `timeTravel().stateAt(stop)` and `stateAt(source, commitIdx)` fold into ONE
  private working copy: the base is cloned once, every bundle is applied
  into it (`applySmartMergeInto`, the same verb switch `applySmartMerge`
  clones for), and the state handed out is one more clone, frozen. Before,
  every bundle cloned the whole state, so a fold over N bundles cost N
  clones — quadratic. Measured on `bench/time-travel.ts` (new, footprintjs
  alone, 10 000 commits, Apple M5 Pro): the fold at the last stop 8.13 s →
  2.8 ms, the middle stop 1.78 s → 0.9 ms. Same answer as the 9.17.0 fold,
  pinned against a fresh fold at every stop (test/lib/time-travel/fold-memo).
- The cursor remembers its last fold (`FoldMemo`, `foldLegsFrom`): a step
  forward on the same leg applies only the bundles after it — one bundle per
  step (15.6 s → 4.8 ms for a step at 10 000 commits). An earlier stop, or
  another leg, folds from scratch; the memo is never a claim. The log is
  never touched by a fold (byte-identical before and after, pinned).
- Why now: the write-side fold was made fast in 9.23; the read side had no
  checked-in number, and a lens standing at a stop of a long run paid the
  quadratic cost on every move.

### Known — a limit the bench found, not yet fixed

- The `executionTree` of a 10 000-stage LINEAR chart nests one level per
  stage and cannot be serialised by `JSON.stringify` (engine recursion
  limit); such a run's snapshot cannot be saved as one JSON artifact. Next
  packet.

## [9.24.0] - 2026-09-12

### Changed — the two write doors store the same bytes (landmine 1 closed)

- **What changes.** Assigning through the typed scope — `s.k = v`,
  `s.k.inner = v`, `s.arr[i] = v`, `s.arr.push(v)`, `s.arr[i].leaf = v` —
  stores the value AS ASSIGNED. Until now the set trap JSON-round-tripped it
  (`Date` → ISO string, `Map`/`Set` → `{}`, own `undefined` dropped,
  `NaN` → `null`) while `$setValue` stored the value itself, so the same
  value had two byte shapes depending on the door (landmine 1, since 9.16).
  The round-trip existed for one reason — to keep the scope's own Proxies out
  of the buffer — and 9.23.3's `reactive/handles.ts` does that in O(1)
  without copying anything, so the copy is gone: the buffer's
  `structuredClone` at commit is the one detaching step for BOTH doors, and
  a `Date` assigned through the scope is a `Date` in state, in the commit
  log and in the fold. Pinned as a law: for any JSON value the two doors
  commit identical rows and identical state (a fast-check property over
  `fc.jsonValue()`, both encodings), and a typed value is the same through
  both, in state and in the fold.
- **What you may notice.** A value nothing can clone — a function, a
  framework's own reactive Proxy — now fails the stage at COMMIT through the
  trap too, loudly (`DataCloneError`), exactly as it always did through
  `$setValue`; before, the trap silently JSON-copied it and dropped the
  function. `s.k = o; o.x = 1` commits `x: 1` — what the stage reads back —
  the same law 9.23.0 gave `$setValue`. A cyclic value assigned through the
  scope keeps its cycle (the round-trip pruned it). Plain JSON values are
  byte-identical to every earlier release. For JSON-only programs nothing
  moves; for programs that assigned typed values through the scope, the log
  now carries what they assigned — a consumer that serialises recordings to
  JSON still sees the ISO string it always saw, at its own boundary.
- **What the round-trip had been hiding.** Running agentfootprint's whole
  suite on this build found one behaviour the copy had silently changed
  for years: an `undefined` inside an array assigned through the scope
  (`skillHistory = [undefined, 'a', 'a', 'b']`, "no skill yet") was recorded
  as `null`, and a gate that counted non-`undefined` slots took it for a
  third skill and switched caching off. Fixed on that side; named here
  because a consumer whose code branches on `null` vs `undefined` in an
  array written through the scope will see the value it wrote from now on.
- **Sites.** `writeTraps.ts · sinkSetTrap`, `arrayTraps.ts` (index set,
  mutating-method arguments, element leaf), `createTypedScope ·
  assignStateKey`; `structuralWrite.ts · unwrapProxy` removed. Docs:
  reactive README ("Assignment stores the value behind the handle"),
  CLAUDE.md landmine 1 retired, the fold guide's §6.

### Fixed — a subflow seed with no fields lands whole

- `seedSubflowGlobalStore` spreads an object seed into per-field writes (a
  row and a redaction verdict per field). Since 9.14.0 it spread EVERY
  non-array object, so a value with no enumerable fields — an empty `{}`, a
  `Date`, a `Map`, a `Set`, a class instance — became zero writes and the
  child read `undefined` for it (a fan-out over `[{}, new Date()]` gave
  every branch an absent `item`; named in 9.23.3). Now only a NON-EMPTY PLAIN
  object spreads; everything else lands whole. The merge-back
  (`applyOutputMapping`) had the same hole for typed values — an
  `outputMapper` returning `{ finishedAt: new Date() }` wrote nothing to the
  parent — and lands them whole now too; an empty `{}` there still merges
  nothing, because a merge of nothing is what it says. Pinned in
  `test/lib/engine/scenario/seed-lands-whole.test.ts` (both encodings, fold =
  state, and the non-empty case's per-field rows byte-identical).

### Added — the structure channel learns the names that land after the stage

- `StructureStageAddedEvent.tags` carries the names declared with the stage
  (`options.tags`, `SubflowMountOptions.tags`, `flowChart({ tags })`) — absent
  when none. New hook `StructureRecorder.onStageTagged(event)` with
  `StructureStageTaggedEvent { stageId, name, tags, spec }`, fired ONLY by the
  `.tag(...)` cursor door, which lands after the stage's `onStageAdded`
  already fired: a recorder that copies fields at add time (instead of
  holding the live `spec`) never learned of those names (named on 9.21.0).
  One declaration, one event — the with-the-stage sites do not fire it. The
  late-attach seed replay carries `tags` too; the arrays on both events are
  copies; a throwing `onStageTagged` is isolated like every other structure
  hook. Exported from the root barrel. Pinned in
  `test/lib/builder/tags-build.test.ts` ("a recorder that COPIES at event
  time still learns every name").

## [9.23.3] - 2026-09-12

### Fixed — a handle the scope handed out is a value the engine accepts back

- **The regression (9.22.0–9.23.2).** `addParallelForEach` over OBJECT items
  lost every child, silently under the default best-effort policy. Found by a
  consumer's upgrade from 9.21.1 with a minimal reproducer: the items selector
  `(s) => s.items` returns the parent scope's array HANDLE, `items[index]` is
  an element handle (a Proxy bound to the parent stage — 9.22.0, the lost-write
  fix), the handler's generated `inputMapper: () => ({ item, index })` seeded
  the branch with it, and the seed commit's `structuredClone` (9.23.0, clone
  once at commit) threw `DataCloneError` before the branch's first stage ran.
  The slot stayed `undefined` (`[null, null]` on the wire), the error went to
  the run's logger, and the run resolved. 9.21.1 handed the raw element back.
  Reproduced here on the current source before the fix, both encodings.
- **The root.** Two designed behaviours — every read is a handle bound to its
  stage; every recorded value is cloned at commit — were correct INSIDE a
  stage and met at the one place neither considered: where the library ITSELF
  carries an app-produced value out of the stage that produced it. There the
  library was handing its own handle to a clone.
- **The fix: one registry, asked at the boundaries.** `reactive/handles.ts`
  maps every proxy the four inner factories build (`rememberHandle`, with the
  same live reader the get trap uses) to the value behind it. `unwrapHandles`
  swaps a handle for that value in O(1) — no walk, no JSON round-trip, a `Date`
  stays a `Date` — walks a plain container copy-on-write only when the app
  built one around handles, and returns a handle-free value as the SAME
  reference (the ordinary write pays nothing). Asked by
  `ParallelForEachHandler · resolveItems` (so `branch(item, index)` and the
  branch seed receive values — 9.21.1's contract), by
  `SubflowInputMapper · extractParentScopeValues` and `applyOutputMapping`
  (a custom `inputMapper: (s) => ({ picked: s.items[0] })` or an
  `outputMapper` that hands a parent handle back — the same defect, the
  ordinary mount), and by the explicit scope doors `$setValue` / `$update` /
  `$batchArray` (`$setValue('copy', s.customer)` now stores the value; it
  used to fail at commit). Nothing else changed: the set trap's JSON
  round-trip of an assigned value (landmine 1) is untouched, so
  `s.copy = s.customer` stores the bytes it always did. `isHandle`,
  `valueBehind`, `unwrapHandles` exported from `footprintjs/advanced`.
- **Still loud, by design.** A GENUINE uncloneable value — a function, a
  foreign Proxy — in a seed still fails at commit: best-effort keeps the slot
  `undefined` and reports through the logger, `failFast` rejects the stage
  (both pinned).
- **Pinned** (`test/lib/engine/scenario/handles-cross-boundaries.test.ts`,
  `test/lib/reactive/unit/handles.test.ts`): the consumer's shape under both
  `commitValues` encodings with every branch's own log folding to its served
  state; nested arrays, flat objects, primitives, order; a `Date` inside an
  item reaching the child as a `Date`; a redaction policy on a seeded field
  still scrubbing the branch's log and redacted snapshot while the branch
  computes on the real value; the ordinary mount's two mappers; the three
  doors; a fast-check property over random item shapes. Benches unchanged
  (1k element writes 5.4 ms, 10k 101 ms).
- **Found, not fixed — pre-existing, named:** `seedSubflowGlobalStore` (9.14.0)
  spreads an object seed value into keys, so an EMPTY object or a bare `Date`
  AS THE ITEM seeds nothing (`c.item` is `undefined` in that branch); nested
  ones are fine. A designed change to the seed's shape, not a patch.

## [9.23.2] - 2026-09-12

### Changed — no behaviour change: every object proxy caches its child proxies, the way the top-level scope always has

- **Why.** The 9.22.0 perf review (finding 4) found that the nested proxy's
  get trap built a FRESH array proxy — with its own empty element cache — on
  every `.arr` access, so `for (i < N) s.k.arr[i]` never hit the element
  cache and allocated an array proxy plus an element proxy per iteration;
  `s.k.arr === s.k.arr` and `s.k.arr[0] === s.k.arr[0]` were false, while
  `s.k === s.k` and `s.arr[0] === s.arr[0]` held. Nested OBJECT members had
  the same shape (`s.k.o` built a nested proxy and copied its ancestor set
  per access), and so did an element proxy's members (`s.arr[0].o`).

- **What changed — one leaf.** `reactive/liveView.ts · cachedMember` over a
  `MemberCache`: a proxy per member NAME under its parent proxy, validated
  by the raw member's identity. It is the cache the top-level scope already
  had (`cachedChildProxy`, now gone — same leaf) and the three object
  proxies now hold one each (`createNestedProxy`, `createTerminalProxy`,
  `createElementProxy`; `liveGetTrap` takes it as its fourth argument). The
  invalidation rule is the one the top-level cache and `cachedElement`
  already used: every write through a proxy rebuilds the containers on its
  path (`structuralWrite.setInPath`), so the raw member is a NEW object
  afterwards, the identity check misses, and the next read builds a proxy
  over the new value; a hit can never be stale, because every proxy reads
  live. Keyed by name under the parent, never by the raw value alone — a
  diamond (one array under `k.a` and `k.b`) gets two proxies, each bound to
  its own path (pinned). The map is allocated on the first insert, so an
  element proxy whose members are all primitives (`{ id, n }`) never pays
  for one, and `build` is the factory's stable child step, so a hit
  allocates nothing.

  One corner moves with it, deliberately: a HELD terminal proxy (the cycle
  edge, `const t = s.k.self`) reading the same object member twice used to
  hand back a proxy the first time and the RAW object the second — its
  shared `visited` set mistook a repeat for a cycle. It now hands back the
  same proxy both times (`memberCache.test.ts`). Unreachable by any of the
  reference suites or the fuzz, which never hold a terminal proxy.

- **Proof.** Zero byte changes: every existing test passes unchanged, the
  nine reference suites are green in both `commitValues` modes, and the
  13,000-program differential fuzz of 9.23.1 (same generator, seeds
  1..13000) run through the 9.23.1 dist and this build produced
  byte-identical snapshots, commit logs, scope events, folds and warnings.
  New: `test/lib/reactive/unit/memberCache.test.ts` (12 tests, 7 red
  before) — identity (`s.k.arr === s.k.arr`, `s.k.arr[0] === s.k.arr[0]`,
  `s.k.o === s.k.o`, `s.arr[0].sub === s.arr[0].sub`, 1,000 reads → ONE
  proxy), invalidation (`s.k.arr[0].n = 1` → the served `s.k.arr` is a
  different proxy over the rebuilt array and reads 1; a held `k` after
  `k.arr.push` sees the new array), the diamond, and one executor run whose
  log records exactly the writes.

- **Measured** (`bench/nested-reads.ts`, new; interleaved A/B, 31/41
  rounds, `readTracking: 'off'` — the proxy's own cost; machine under
  unrelated load ~7). N = 1k / 10k, stage body ms, 9.23.1 → 9.23.2:
  one pass `s.k.arr[i].n` 0.61 → 0.61 / 6.97 → 7.77; two reads per index
  (`s.k.arr[i].n * s.k.arr[i].id`) 1.44 → 1.01 / 11.9 → 10.8; two passes
  1.89 → 1.55 / 11.4 → 11.0; nested object `s.k.o.x` 0.41 → 0.29 / 4.65 →
  2.60; hoisted `arr[i].n` unchanged within noise. The one-pass loop at 10k
  is +12% because it now RETAINS the 10k element proxies it touched (as the
  hoisted loop always did) instead of discarding them young; every repeated
  read is cheaper, `s.k.arr` alone halves (2.4 → 1.1 ms per 10k). What the
  bench also shows, under the DEFAULT dial: `for (i < N) s.k.arr[i]` is
  ~220 ms at N = 1k in BOTH versions, because each `s.k` is a tracked read
  and `readTracking: 'full'` retains a `structuredClone` of `k` per read —
  the proxy is not the cost there; hoist `s.k` (now in the reactive README's
  performance guidance). `bench/element-writes.ts` and `bench/read-cost.ts`
  are within noise (1k element writes 1.95 → 2.00 ms body; 643 → 669
  ns/read on medians, mins 12.52 → 12.61 ms).

## [9.23.1] - 2026-09-11

### Changed — no behaviour change: the proxy factories are orchestrators over shared leaves

- **Why.** `createTypedScope`, `createNestedProxy`, `createTerminalProxy`,
  `createArrayProxy` and the element proxy each carried their get / set /
  delete / mutating-method traps INLINE — the same logic three times with
  small differences. That is exactly how the 9.22.0 stale-read bug was fixed
  in the element proxy and then found again in the nested and terminal ones.
  `liveView.ts` (9.22.0) began the cure for the READ traps; this release
  finishes it for the WRITE side. Rule, now written into
  `src/lib/reactive/README.md` ("How the proxies are built"): an
  orchestrator only CALLS leaves in a readable sequence and holds state; a
  leaf computes one thing and never orchestrates; a fix lands in a leaf once.

- **What moved.** `reactive/writeTraps.ts` (new) — the `WriteSink` seam
  (`readAt` / `put` / `remove`, a path measured from the sink's root), its two
  implementations `rootKeySink` (object leaf ⇒ `merge` of a nested patch;
  array leaf or delete ⇒ `set` of the immutably rebuilt root — reactive law
  3) and `elementSink` (every write ⇒ the WHOLE owning array back through the
  array proxy's commit), and the one `sinkSetTrap` (unwrap the assigned value
  per landmine 1, hand it to the sink) / `sinkDeleteTrap` every object proxy
  uses. `reactive/liveView.ts` gains `liveGetTrap` — the guards and the JSON
  law once; only the CHILD step (the cycle policy) is a parameter.
  `reactive/arrayTraps.ts` — `mutatingMethod`, `setIndex`, `setLength`,
  `deleteSlot`, `cachedElement`, `indexIn`, `boundMember`, `arrayProxyAt`
  are the named leaves; `createArrayProxy` and `createElementProxy` wire
  them. `reactive/createTypedScope.ts` — `internalRead`, `wrapStateValue`,
  `cachedChildProxy`, `assignStateKey`, `knownKey`, `stateKeys` are the
  top-level leaves; the three factories are 15–25 lines each.
  `memory/TransactionBuffer.ts` — `toDeltaPayload` reads as a sequence
  (`opsByPath` → `netChangeSurvivors` → `groupIntoFamilies` →
  `memoisedFamilyValue` → the verb switch → `emitInFamilyOrder`); the verb
  switch itself is the delta encoder's own replica of the verb law
  (CLAUDE.md, "FOUR verb-switch replicas in lockstep") and stays where it
  was, in one body — the leaves are extracted AROUND it, never from it.
  `changedSinceBase` is now the ONE net-change verdict both encodings ask;
  `flattenedTraceRow` names the `'full'` mode's delete→set flattening.

- **Proof.** Zero byte changes. Every existing test passes unchanged; the
  byte-identity and reference suites (`declared-tags-byte-identity`,
  `redaction-no-policy-byte-identity`, `repeated-path-byte-identity`,
  `assigned-value-only`, `clone-once-at-commit`, `deep-writes-through-arrays`,
  `held-handles-and-typed-values`, `redaction-one-law`,
  `redaction-subflow-served-state`) are green in both `commitValues` modes;
  and a differential fuzz of 13,000 random multi-stage programs (nested
  objects, arrays, element writes, every mutating method, `delete`,
  `$update` / `$setValue` / `$batchArray`, held handles, cycles, subflows,
  redaction, dev mode, both encodings, three read-tracking modes, write
  provenance) run through the 9.23.0 dist and this build produced
  byte-identical snapshots, commit logs, scope events, folds and warnings.
  `bench/element-writes.ts` and `bench/read-cost.ts` are within noise.

## [9.23.0] - 2026-09-11

### Changed — the element-write loop goes linear: clone once at commit, and unwrap only the assigned value

- **Why.** After 9.22.1 the commit and the fold of an N-element-write bundle
  were O(N), but the stage BODY was still O(N²): every `arr[i].n = i` paid
  two `structuredClone`s of the whole new array — `TransactionBuffer.set`
  copying it into `overwritePatch`, and `StageContext.trackWrite` copying it
  into `_stageWrites` — for a value the next write overwrote. Both copies
  are right in intent (the record must never alias the caller's object) and
  wrong in timing: a patch only has to be final at COMMIT, and the last
  write to a path wins. Design: `docs/design/2026-09-clone-once-at-commit.md`.

- **What changed — two owners, one law each, the four verb replicas
  untouched.** Memory (clone once at commit):
  `TransactionBuffer · set / delete / merge` store the caller's reference in
  the patch trees (as `workingCopy` always did); `toChangeOnlyPayload` /
  `toDeltaPayload` — the ONE place a payload leaves the buffer — take the
  copy, once per surviving path, in the 9.22.1 memo loop that already sat
  there. `StageContext · trackWrite` holds the reference and the verdict
  `stageWrite` asked the rule for BEFORE staging in a pending map;
  `materialiseWrites`, the first act of `commit()`, takes the retained form
  (the `writeTracking` clone or summary, the redaction placeholder or field
  scrub) once per key from the final value; `retainedWrites()` is the
  non-consuming fold every reader of `_stageWrites` goes through, so a
  mid-run snapshot is honest, and `discardStaged` (retry) drops the pending
  map with the rest — bare references, nothing to un-clone. Redaction has no
  new scrub point: the rule is asked where it was, and the commit-time clone
  sees only what it allowed in. Reactive (assigned value only): `arrayTraps`
  unwraps the value at the trap that receives it and `createTypedScope`'s
  three array commit callbacks hand the rebuilt array on as it is — see
  moved behaviour 2.

- **Two behaviours move in this release — both in the direction of the record
  telling the truth. Each is stated plainly below with its example and the
  honest form of the old intent.**

- **Moved behaviour 1 — CLAUDE.md landmine 3's first bite, closed.**
  A caller who mutates its own object after the write and before the stage
  ends now commits the value AS THE STAGE READ IT BACK. 9.22.1 committed a
  stale write-time snapshot the stage itself never saw — log and stage
  disagreed; now they agree (the 9.22.0 law, "fold === state"). Pinned by
  name in `test/lib/memory/scenario/clone-once-at-commit.test.ts`, both
  encodings:

  ```ts
  const o = { x: 0, tags: ['a'] };
  scope.$setValue('doc', o);
  o.x = 1;                 // the caller's own object, after the write
  // 9.22.1: bundle.overwrite.doc = { x: 0 }   — the stage read { x: 1 }
  // 9.23.0: bundle.overwrite.doc = { x: 1 }   — log, fold, sharedState, stageWrites agree
  ```

  The honest form of the old intent is `scope.$setValue('doc',
  structuredClone(o))`. The second bite — a RAW element held past its stage
  — is unchanged and stays named. Refused: freezing the caller's object
  after the write (a library must not freeze what it did not create).

- **Moved behaviour 2 — the array traps unwrap the ASSIGNED value only
  (landmine 1, now true for element writes too).** The second per-write O(N)
  cost was not a clone: the three `createArrayProxy` commit callbacks in
  `createTypedScope` JSON-round-tripped the WHOLE rebuilt array on every
  element write (`target.setValue(prop, unwrapProxy(newArr))` and its nested
  twins) — measured 0.13 ms × 1,000 = 130 ms of the 129 ms body at 1k and
  1.35 ms × 10,000 = 13.5 s of the 14.3 s body at 10k after the clone work
  alone. That was over-broad under 9.22.0's own law: writing element 3 must
  not alter the bytes of element 5, yet it stringified every untouched
  sibling's `Date` and flattened its `Map`. Now `arrayTraps.ts` unwraps what
  the caller handed in, at the trap that receives it — the index-set element,
  a `MUTATING_METHODS` call's arguments (`push(x)`, `splice(i, n, ...items)`,
  `fill(x)`; numbers and comparators pass through), the element-proxy leaf
  (already so) — and the rebuilt array is committed as it is, untouched
  siblings by reference. Pinned by name in
  `test/lib/reactive/scenario/assigned-value-only.test.ts`, both encodings:

  ```ts
  scope.$setValue('arr', [new Date('2020-01-01T00:00:00Z'), new Map([['a', 1]]), { n: 0 }]);
  // next stage:
  scope.arr[2].n = 1;        // an element write
  // 9.22.1: arr[0] === '2020-01-01T00:00:00.000Z', arr[1] deep-equals {}   — siblings round-tripped
  // 9.23.0: arr[0] instanceof Date, arr[1] instanceof Map               — siblings untouched, fold agrees
  scope.arr[2] = new Date(); // the ASSIGNED value: still a string after commit (landmine 1 unchanged)
  scope.arr = [new Date()];  // a whole-array ASSIGNMENT: every element still round-tripped — it IS the value
  ```

  The honest form of the old intent — "normalise the whole array through
  JSON" — is `scope.arr = [...scope.arr]` (an assignment) or
  `scope.$setValue('arr', JSON.parse(JSON.stringify(scope.$getValue('arr'))))`.
  The one thing the round-trip did for the array's SHAPE is kept explicitly:
  `delete arr[i]`, a write past the end and `length` growth spell holes as
  `null` (`arrayTraps` · `fillHoles`; the existing "emptied slot reads as
  `null`" scenario passes unchanged). A proxy pushed or assigned into an array
  (`arr.push(scope.customer)`) is still unwrapped — at the argument.

- **Where the design page was incomplete — two places, both now pinned.**
  (1) The engine's OWN nested ops. A nested `merge` writes its RESULT into
  `workingCopy` only (the delta goes to `updatePatch`), so a container shared
  between the trees would leak the merged value into `overwrite` — bytes
  9.22.0 never had. `TransactionBuffer · detachHeldAncestors` clones a held
  ancestor in `overwritePatch` before any nested op writes through it; the
  scope proxy never takes that path (it writes root keys), the 9.22.0
  `set-merge-interleaved` reference pins it, and a unit test names it.
  (2) An UNCLONEABLE value (a function, a Proxy) now fails at COMMIT instead
  of at the write: the run still fails loudly with the `DataCloneError`, but
  the stage cannot catch it and none of that stage's writes land (the payload
  itself cannot be built). "State values must survive `structuredClone`" is
  the standing invariant; a failed run still snapshots.

- **Bytes identical where the caller does not mutate.** The three reference
  suites pass unchanged in BOTH encodings — `repeated-path-byte-identity`
  (9.22.0 bytes: log, folds, `commitValueAt` per key), `redaction-no-policy-
  byte-identity` (9.18.1 / 9.19.1), `declared-tags-byte-identity` (9.20.0) —
  and so do retry isolation / execution / invariants, redaction one-law,
  subflow served-state, subflow seed + merge-back and cross-executor resume.
  `test/lib/memory/scenario/clone-once-at-commit.test.ts` pins the law kept
  (after commit, mutating the caller's object changes nothing in the log,
  the mirror, `stageWrites` or the fold) and the moved behaviour above; the
  write-tracking scenario now counts its clones at commit (0 at the write;
  2 under `'full'`, 1 under `'summary'`/`'off'`; a key written 50 times
  cloned once per site).

- **Measured** (`bench/element-writes.ts`, Apple M2, Node 22, median of 5;
  10k is one run; `loop` = N element writes through the proxy in one stage;
  `body` = the stage function alone, `total` = the whole run):

  | N | mode | body 9.22.1 → clone-once → 9.23.0 | total 9.22.1 → 9.23.0 | fold |
  |---|---|---|---|---|
  | 100 | full | 6.6 → 2.4 → 0.37 ms | 7.5 → 0.86 ms | 0.16 ms |
  | 100 | delta | 6.4 → 1.6 → 0.31 ms | 6.8 → 0.76 ms | 0.14 ms |
  | 1,000 | full | 606 → 129 → 2.6 ms | 609 → 5.7 ms (−99%) | 1.2 ms |
  | 1,000 | delta | 616 → 129 → 1.9 ms | 619 → 4.8 ms (−99%) | 1.1 ms |
  | 10,000 | full | 61,520 → 14,328 → 75 ms | 61,548 → 104 ms (−99.8%) | 16 ms |
  | 10,000 | delta | 61,377 → 13,600 → 79 ms | 61,407 → 109 ms (−99.8%) | 12 ms |

  The middle column is the clone-once step alone (−78%), which showed the
  1k→10k ratio still at ~109× and led to the second site. **The 1k→10k ratio
  is now 18× (total) / 29× (body)** — not the ≈10× the design asked for, and
  the residual is named, not chased: the array proxy's own copy-on-write, one
  shallow copy of the array per element write (`arrayTraps` ·
  `replaceInElement` and the traps' `[...getCurrent()]`), measured 0.0089 ms
  × 10,000 = 89 ms ≈ the whole 75 ms body at 10k and 0.4 ms of the 2.6 ms at
  1k (the rest at 1k is fixed per-write cost, ~2 µs). That copy is the
  intended price of an immutable rebuild — ~1 ns per element — so beyond ~10k
  elements the loop is still quadratic in it, at a constant 10,000× smaller
  than 9.22.1's. `$batchArray` remains the bulk path (one row, one copy):
  ~2× cheaper in the body at 1k, ~6× at 10k.

## [9.22.1] - 2026-09-11

### Changed — a row a later row re-sets is not cloned twice: commit and replay of a repeated-path bundle are O(N), not O(N × rows)

- **Why.** The 9.22.0 perf review profiled N = 1,000 element writes on one
  array in one stage (`arr[i].n = i`): 1,131 ms, of which 246 ms was
  `TransactionBuffer.toChangeOnlyPayload` cloning the whole array once per
  staged op and 252 ms was `applySmartMerge` cloning it once per trace row
  at the live commit — 1,000 rows on ONE path, 1,000 clones of the same
  array in each place — and every fold of that bundle afterwards
  (`EventLog.materialise`, `commitValueAt`, `stateAt`) paid the replay half
  again. The funnel is older than the fix that made it reachable: both loops
  predate 9.22.0, which made a nested element write commit as a whole-array
  `set` of its root key (law 3) and so, for the first time, put N whole-array
  rows on one path in one bundle. The bytes of such a bundle are O(N); the
  work was O(N × rows).

- **What changed — one law, two loops, no fifth verb switch.** CONSECUTIVE
  ops on the same path and the same patch tree, with nothing in between, are
  materialised once: the value at a path is fixed at commit, so the earlier
  copy writes the same bytes over the same key and is unobservable — key
  order and container creation included. Replay: `memory/utils.ts ·
  supersededByNextSet`, asked by `applySmartMerge` before its verb switch
  (so the live commit, the redacted mirror, `materialise` and `stateAt`
  inherit it from the one place they already share) and by the delta
  encoder's own per-family fold (`TransactionBuffer.replayFamilyVerbs`);
  `commitValueAt` needs nothing — it anchors at the last `set` by
  construction. Commit: `TransactionBuffer.toChangeOnlyPayload` decides the
  net-change verdict once per path and copies a path into `overwrite` /
  `updates` only when the previous surviving op on that tree was not the
  same path. Consecutive only, deliberately: a descendant op in between can
  coerce a materialised primitive (`set list; delete list.1; set list = 0`
  turned `0` into `{}` under a "once per path" draft) or leave a `key:
  undefined` shell that the re-copy is what wipes — a property test found
  the first within 228 runs. The trace rows are all still recorded; the log
  is the record of what happened, and N things happened.

- **Bytes identical, proven three ways.**
  `test/lib/memory/scenario/repeated-path-byte-identity.test.ts` pins a
  fixture with repeated-path `set` / `merge` / `append` / `delete`, mixed
  interleavings, reverts, nested paths beside their ancestor and a subflow
  seed against reference bytes generated on the 9.22.0 tree (40fc152) in
  BOTH `commitValues` encodings — log, final state, `stateAt` at every stop,
  `commitValueAt` per key at every index, own-`undefined` shells visible.
  The existing delta≡full replay property tests and the time-travel /
  memory equivalence suites pass unchanged. A differential fuzz of 6,000
  random multi-stage programs (both encodings, redaction on) between the
  9.22.0 build and this tree agreed byte for byte.
  `test/lib/memory/unit/repeated-path-skips.test.ts` pins the law's edges
  and counts the clones actually skipped.

- **Measured** (`bench/element-writes.ts`, new — Apple M2, Node 22, median of
  5; 10k is one run). `total` is the whole run, `fold` one `stateAt` of the
  finished log; `commitValues: 'full'`, the default:

  | N | rows | total 9.22.0 → 9.22.1 | fold 9.22.0 → 9.22.1 |
  |---|---|---|---|
  | 100 | 100 | 11.8 ms → 8.5 ms | 2.6 ms → 0.15 ms |
  | 1,000 | 1,000 | 1,039 ms → 586 ms (−44%) | 241 ms → 1.1 ms |
  | 10,000 | 10,000 | 107,051 ms → 58,765 ms (−45%) | 24,562 ms → 13 ms |

  `'delta'` was already one row per path at commit and is unchanged
  (1k: 560 ms → 588 ms, run-to-run noise). What remains at 1k (≈ 585 ms)
  is the stage BODY — the proxy's per-write array copy, one per element
  write, untouched here — which is why `src/lib/reactive/README.md` now says
  it plainly: N element writes in one stage produce N whole-array rows;
  `$batchArray` is the bulk path, ~370× cheaper in the body at N = 1,000
  (the same bench prints the ratio).

## [9.22.0] - 2026-09-11

### Fixed

- **A deep write through an array is no longer lost in silence.** A mutation
  made through the typed scope could vanish: no error, no trace row, and a
  final `sharedState` still holding the old value. Reported against the
  shipped build with plain charts, no mocks, in a stage running after a seed
  stage created the container:

  ```
  s.obj.deep.n = 99          landed
  s.arr[0].n = 99            landed
  s.nested.lines[0].n = 99   LOST   (final value still 1)
  s.a.arr[0].n = 99          landed
  s.b.arr[0] = { n: 99 }     LOST
  s.c.arr[1] = 99            LOST   (primitive element)
  s.d.deep.arr[0].n = 99     LOST
  ```

  The same shape landed in one run and was lost in another, which made it
  look non-deterministic. It was not. TWO deterministic defects were
  interleaving, and each is fixed at its own root.

  **Why it mattered more than a wrong value.** Every lens in this family
  answers "what happened" FROM THE LOG. A write that never reaches the log
  makes the Served graph, the data graph and the causal chain confidently
  wrong together, with nothing in the record saying so — the one failure mode
  the whole design exists to prevent. In the first family it was worse than a
  loss: the run's own `sharedState` and the fold of its own commit log
  disagreed, in opposite directions, with an EMPTY bundle for the stage that
  did it.

  **Family A — the proxy chain broke at an array index.** `createArrayProxy`'s
  get trap returned `current[index]` raw, so `…arr[i].prop = v` was an
  ordinary in-place mutation of a BORROWED read, and no trap ever fired.
  Whether the value survived was decided by which backing store the read came
  from: before the stage's first staged write, reads are bare references into
  committed shared memory, so the mutation edited committed state in place
  (state moved, log empty — the rows marked "landed" above are this case, and
  it also violates *committed state is immutable-after-swap*); after the first
  staged write, reads come from the transaction buffer's private clone, so the
  mutation was dropped at commit. Position relative to the stage's first write
  was the whole difference.

  An indexed read of a wrappable element now returns an ELEMENT PROXY that
  carries the path inside the element and, on write, rebuilds the array
  immutably and hands the whole new array to the same commit callback `push`
  already used. Objects and arrays nested inside elements are covered to any
  depth, and so are `delete` on an element property and on an array index
  (which previously reached the raw target array with no commit record at
  all). Element proxies are cached per index and validated by identity, so
  `lines[0] === lines[0]` holds within a stage and a read loop does not
  allocate per access.

  **Family B — a nested array write committed with the wrong verb.** An array
  that was not itself a top-level key committed through `merge`, and merge's
  array arm is a set UNION (`deepSmartMerge`). `[1,2,3]` merged with the
  intended `[1,99,3]` became `[1,2,3,99]`: element replacement, reordering and
  shrinking were unrepresentable through any nested array. The log recorded
  the union faithfully, so log and state AGREED and were both wrong against
  what the stage asked for. `splice`, `sort`, `reverse`, `shift`, `pop` and a
  shorter reassignment were all silently ineffective; a nested `sort` produced
  no trace row at all (the union of the sorted array with the original equals
  the original, so the net-change filter correctly dropped a real write).

  An array mutation always hands back the COMPLETE new array, and `set` is the
  only verb that can say so. Nested array writes now commit as a `set` of the
  ROOT KEY — the same thing a top-level array write has always done, and the
  granularity `findLastWriter`, `sliceForKey` and `causalChain` index by, so
  one trace path per state key still holds whatever depth the write was
  addressed at. `deepSmartMerge` itself is untouched: `$update`'s array-union
  semantics and the subflow `outputMapper` concat law are exactly as before.

  Reproduce, on 9.21.1:

  ```ts
  const chart = flowChart('seed', (s) => { s.k = { arr: [{ n: 1 }] }; }, 'seed')
    .addFunction('mutate', (s) => { s.k.arr[0].n = 99; }, 'mutate')
    .build();
  const ex = new FlowChartExecutor(chart);
  await ex.run({ input: {} });
  const snap = ex.getSnapshot();
  snap.sharedState.k.arr[0].n;          // 99 — committed state, edited in place
  snap.commitLog[1].trace;              // []  — the stage recorded NOTHING
  // add any write before it (`s.z = 1;`) and the SAME line yields 1 instead.
  ```

  **What a consumer should expect now.** Every write the scope proxy can reach
  produces a trace row, and folding the commit log from `initialState`
  reproduces `sharedState` exactly — asserted for every row of the table
  above, in isolation and in sequence, under both `commitValues` modes, plus a
  subflow and a resumed run. A nested array write appears in
  `bundle.overwrite` under its root key with verb `set`, where it used to
  appear in `bundle.updates` with verb `merge`; nested OBJECT writes are
  unchanged (still `merge`, still a delta). `getSnapshot().sharedState` and
  `stateAt()` no longer disagree.

- **`delete scope.a.b.c` lands.** A nested `delete` had no trap at all, so it
  was a silent no-op: `merge` cannot express a removal (a patch of `undefined`
  reads as absent to every consumer), so the key is now removed from a copy of
  the root and committed as a `set` of that root key.

### Changed

- **An array ASSIGNMENT replaces, at every depth.** `scope.k.tags = ['b']`
  used to APPEND (`['a','b']`) because it went through `merge`, while the
  identical expression one level up — `scope.tags = ['b']` — replaced. The
  same code meant two different things by depth, and a shorter array
  (`scope.k.arr = [1]`) could not be expressed at all. Assignment now replaces
  everywhere. `$update(key, { tags: [...] })` is unchanged and remains the
  explicit append; so is the subflow `outputMapper` array-concat law. This is
  the only behaviour change to a write that previously landed, and it is why
  this release is a minor rather than a patch.

### Added

- **`pathSegments(path)` — exported from `footprintjs/trace` and
  `footprintjs/advanced`.** A `TraceEntry.path` joins its segments with an
  ASCII Unit-Separator, which is an ENCODING, not a display character: a
  consumer that printed one got a single broken-looking word, and the only way
  to take it apart was to split on an undocumented control character.
  `pathSegments` is the supported inverse of `normalisePath`; the delimiter
  stays an implementation detail.

  The separator is not a dot for a reason that was never written down: a state
  key may itself CONTAIN a dot, and this library creates such keys routinely —
  `$setValue` takes a KEY, not a path, so `$setValue('a.b', v)` makes one
  top-level key literally named `a.b`. With a dot separator that key's path
  and the nested path `['a','b']` would both encode as `"a.b"`, and every
  reader of the log would have to guess which a bundle meant. `DELIM`'s
  comment now says that instead of listing two incidental properties.

  ```ts
  import { pathSegments } from 'footprintjs/trace';
  for (const entry of bundle.trace) {
    console.log(pathSegments(entry.path).join(' › ')); // 'order › lines'
  }
  ```

- **A dev-mode warning for the writes the proxy CANNOT see.** An element
  reached without an index — `find`, `filter`, `for…of`, `forEach`,
  destructuring — is still handed back raw, deliberately: wrapping those would
  mean returning proxies out of every read method (`map` would build an array
  of proxies, a value could escape the stage still bound to it), a cost the
  library should not pay and a semantic change it should not make. So that
  family is WARNED ABOUT rather than intercepted. Under `enableDevMode()`,
  `StageContext.commit` compares what the stage read with what the value holds
  at commit — a key it read but never staged must still hold it — and warns
  with the exact path and the two ways to write it back:

  ```
  [footprint] Stage "price" changed `order.lines[0].qty` IN PLACE, on a value it
  only read. footprint never saw that write: there is no trace row for it, so the
  commit log, the causal chain and every reader that folds the log will disagree
  with final state — and under a different write order the change is dropped
  entirely. Reads are BORROWED. Write through the scope instead
  (`scope.order.lines[0].qty = …` — property and indexed access are both
  tracked), or hand back the whole value with `scope.$setValue('order', next)`.
  ```

  Costs nothing and says nothing outside dev mode; the default path is
  byte-identical. Two preconditions, both required: `enableDevMode()` and
  `readTracking: 'full'` (the default) — the comparison needs the clone that
  mode retains at read time, so under `'summary'` or `'off'` the guard is
  silent. It is a REPORT after the fact, not a refusal at the write (the write
  already happened in place; there was nothing to intercept), and it runs at
  the frame's first commit only.

### Found in review

An adversarial review of this release confirmed its own claims (every row of
the table above, in isolation and in sequence, both encodings, subflow, resume,
committed references untouched) and found FOUR shapes still lost with no trace
row and named nowhere. Each is closed at its root, with a red-before test.

- **A `Date`, `Map` or `Set` compared equal to any other.** `deepEqual`
  (`memory/utils.ts · equalPairs`) walked own enumerable keys, and these
  have none — so the net-change filter dropped `$setValue('k', new
  Date(1999))` over a 2020 date as "no change" (no row, state unchanged), and
  the dev-mode guard could not see `scope.k.when.setFullYear(1999)` or
  `scope.k.tags.add('b')` in place. State values must survive
  `structuredClone`, which keeps all three, so they are legal values the
  filter has to tell apart. Typed arms now compare a `Date` by instant and a
  `Map`/`Set` by size and members (deep, order-insensitive for a `Set`);
  arrays, objects and the 9.19.1 rule (own `undefined` ≡ absent) are
  unchanged.

  ```ts
  s.$setValue('k', new Date('2020-01-01'));   // stage 1
  s.$setValue('k', new Date('1999-01-01'));   // stage 2 — now: trace row `k:set`, fold agrees
  ```

- **`$batchArray` handed the stage the COMMITTED elements.** The working copy
  was a shallow `[...current]`, so `$batchArray('k', a => { a[0].n = 9 })`
  edited committed state in place — violating *immutable-after-swap* — with
  no row, and the lazy buffer's base was taken after the edit, so the filter
  saw nothing. The copy is now `structuredClone(current)` ("clone once" means
  the elements too); the result commits as one `set` of the key exactly as
  before, and a Date or Map inside an element survives.

- **A held element proxy read STALE after its own write.** `createElementProxy`
  read from the object captured at creation, but every write rebuilds the
  array immutably, so `const line = s.k.arr[0]; line.n += 1; line.n += 1`
  gave 2 — two honest `set` rows, wrong value — and `line.total = line.qty *
  10` used the old `qty`, `'x' in line` was false right after `line.x = 1`.
  Every trap now resolves the element through the CURRENT value (falling back
  to the captured object only when the slot is gone): `line.n += 1` twice is
  3, `line.qty = 2; line.total = line.qty * 10` is 20, `'x' in line`,
  `Object.keys(line)` and `JSON.stringify(line)` see the write. The nested and
  terminal OBJECT proxies had the same root (`const o = s.k.o; o.x += 1` twice
  gave 2, and so did a held top-level `const k = s.k`) and follow the same law
  now — one `liveView.ts` behind all three, so a consumer never has to know
  which kind of proxy a handle is.

- **A scope handle held past its stage wrote into a dead frame.** A proxy
  captured in stage A (`held = s.k`) and written in stage B (`held.n = 9`)
  reached A's context, whose buffer nothing ever commits again — the write
  vanished with no row and no error. A facade is one stage execution's
  handle, so it is now SEALED by its commit observer and a later write through
  it, or through any proxy bound to it, throws naming the stage the handle
  came from; the error is raised in — and attributed to — the stage that wrote
  (`ScopeFacade · assertLive`). Reads through a held handle are not refused.
  The seal is on the facade, not on `StageContext.stageWrite`: the frame's
  re-usability after commit is what the engine's double-commit paths (fork
  child, subflow merge-back into a committed branch parent) rely on.

  ```ts
  let held;
  flowChart('A', (s) => { held = s.order; }, 'A')
    .addFunction('B', (s) => { held.total = 9; }, 'B'); // throws: Stage "A" (A#1) has already committed …
  ```

  What this cannot catch, now documented (`src/lib/reactive/README.md`,
  CLAUDE.md landmine 3): a RAW handle held that long — an element from
  `find`/`filter`/`for…of`, or anything from `$getValue`/`$read`/`$toRaw` —
  is the committed object itself; mutating it in a later stage edits state in
  place, and the dev-mode guard sees it only if that stage also reads the key.

Also from the review: the guard's "nested seed keys" exemption was keyed on a
dot in the read key, which silently exempted a user's own dotted top-level key
(`s['a.b'].arr.find(…).n = 9` never warned). It is now keyed on an explicit
marker for reads made at a nested path — which only the engine's subflow
merge-back does — so a dotted user key is guarded like any other.

Named by the same review and deliberately NOT fixed — out of contract, dropped
or refused as follows (also in `src/lib/reactive/README.md` under Limitations):
a cyclic self-reference reached through a terminal proxy commits its
array/element write to the wrong place (a row is recorded and the fold agrees
with state, but the value lands beside the cycle edge); a top-level key
containing U+001F, the trace path separator, throws at the seed; an expando
property on an array (`scope.k.arr.foo = 1`) is dropped by the array proxy's
set trap, which handles indices and `length` only.

## [9.21.1] - 2026-09-10

### Fixed

- **A subflow mount can now be tagged.** 9.21.0 gave every stage-shaped
  node a `tags` site — `.tag()` after it, or `{ tags }` at a decider /
  selector / branch / fork child's own declaration — but a subflow MOUNT had
  none: `SubflowMountOptions` carried no `tags`, and no mount method landed
  one. Found while a consumer declared its milestones: its three
  context-slot mounts (selector-branch mounts in every agent chart) could
  not be tagged, so inside an otherwise tagged recording those three stops
  fell back to id derivation — exactly the fallback declared tags exist to
  retire. A mount is a stage that commits (its first bundle in the parent
  log is a stop in `commitStops`), so law 3 of the design — the tag is the
  fact — needs it taggable.

  Now `SubflowMountOptions.tags?: readonly string[]` lands through the same
  `applyTags` as every other site, from all eight mount methods
  (`addSubFlowChart`, `addSubFlowChartNext`, both `addSubFlowChartBranch`es,
  and their lazy twins — the option type is shared, so a field three of
  them ignored would be a silent no-op). Same refusals (empty, non-string,
  the reserved `~`, a duplicate, a second declaration). The tag lands on the
  mount's FIRST bundle in the parent log; the exit bundle carries none; the
  subflow's own log is untouched (its inner stages declare their own, and
  `drill(mount)` reads those). An untagged mount is byte-identical to 9.21.0
  — the 9.20.0 reference still passes unchanged.

  `.tag()` after `addSubFlowChart` / `addSubFlowChartBranch` still refuses:
  those leave the cursor on the parent (a fork-child mount is one of N
  siblings), so "the stage you just added" stays ambiguous — the same law
  `.retry()` keeps and `addListOfFunction` children follow. The refusal now
  names the site. `.tag()` after `addSubFlowChartNext` worked already (the
  cursor moves) and still does; declare in one place, not both.

  ```ts
  import { flowChart } from 'footprintjs';
  import { tagStops, timeTravel } from 'footprintjs/trace';

  const chart = flowChart<State>('Seed', seedFn, 'seed')
    .addSelectorFunction('Slots', pickSlots, 'slots')
    .addSubFlowChartBranch('memory', memoryChart, 'Memory', { tags: ['slot:memory'] })
    .addSubFlowChartBranch('tools', toolsChart, 'Tools', { tags: ['slot:tools'] })
    .end()
    .addFunction('Call model', callFn, 'call-llm')
    .tag('milestone:llm-turn')
    .build();

  // …run it; later, anywhere:
  const cursor = timeTravel(snapshot, { strategy: tagStops(['slot:memory', 'slot:tools']) });
  cursor.stops.map((s) => s.kind);   // ['start', 'mount', 'mount', 'end']
  cursor.stops[1].meta;              // ['slot:memory'] — the mount's own bundle
  // `drill` carries the strategy into memoryChart's OWN log, where nothing says 'slot:memory':
  cursor.drill(cursor.stops[1].runtimeStageId)!.stops.map((s) => s.kind); // ['start', 'end']
  // …an unfiltered cursor's drill reads the inner stages' own tags instead.
  ```

  Sites: `engine/types.ts · SubflowMountOptions.tags` · `FlowChartBuilder.ts`
  (the eight mount methods call `applyTags`; `.tag()`'s cursor-tail refusal
  names the option). Tests: `test/lib/builder/tags-mount-build.test.ts`,
  `test/lib/engine/declared-tags-mount.test.ts`.

## [9.21.0] - 2026-09-10

### Added

- **Declared tags — a name on the stage, carried by its commit.** A stored
  recording could not say which of its stops were milestones. Every reader
  that wanted "the LLM turns" classified stages from their ids — a switch over
  `runtimeStageId` that parses `#` and `/`, lives in the consumer, and goes
  stale the day a stage is renamed (agentfootprint's `milestoneFor` is that
  switch). The chart's author knew the answer at build time and had nowhere
  to put it.

  Now the author puts NAMES on a stage — `.tag('milestone:llm-turn')` after
  the stage, or `{ tags: [...] }` at a decider / selector / branch / fork
  child's own declaration site — and the engine stamps them on the stage's
  commit bundle (`CommitBundle.tags`). A recording from ANY chart carries its
  own milestones; `tagStops(tags?)` in `footprintjs/trace` scrubs by them
  with no id conventions in the reader (keep when ANY of the asked-for names
  matches — every tagged stop when none are asked for; an untagged stage
  folds into the tagged stop BEFORE it; `Stop.meta` carries the bundle's
  whole array). The built spec advertises the vocabulary
  (`SerializedPipelineStructure.tags`), so a lens draws its legend before
  the run exists.

  The laws, so nothing is re-derived: a tag is a NAME declared at build time
  — never a value, so there is no run-time `$tag()` (a runtime string could
  carry data past every redaction point; data-dependent marks are a keep
  rule over the fold, or `$emit`). Absent when empty: an untagged chart's
  log, snapshot, checkpoint and every recorder output are byte-identical to
  9.20.0 (pinned by a reference generated on the 9.20.0 tree). Stamped ONCE
  per execution of the stage: retry attempts share one stamp, a failed stage
  keeps its tag (the error path commits before it rethrows), an empty commit
  is a tagged stop, a fork child's fan-out repeat and a mount's exit bundle
  carry none, a stage that pauses and is resumed on a fresh executor is two
  tagged stops on a chained axis (it ran twice). Refused at build: an empty
  name, a non-string, the reserved `~` marker, a duplicate, a second
  declaration on the same stage.

  ```ts
  import { flowChart } from 'footprintjs';
  import { tagStops, timeTravel } from 'footprintjs/trace';

  const chart = flowChart<State>('Seed', seedFn, 'seed')
    .addFunction('Call model', callFn, 'call-llm')
    .tag('milestone:llm-turn')
    .addFunction('Trim', trimFn, 'trim')
    .addFunction('Route', routeFn, 'route')
    .tag('milestone:decision', 'audit')
    .build();

  // …run it, keep the snapshot; later, anywhere:
  const cursor = timeTravel(snapshot, { strategy: tagStops(['milestone:llm-turn', 'milestone:decision']) });
  cursor.stops.map((s) => s.label);   // ['Run start', 'Call model', 'Route', 'Run end']
  cursor.stops[1].meta;               // ['milestone:llm-turn']
  cursor.stops[0].prologue;           // true — 'seed' ran before the first tagged stage
  ```

  Sites: `builder/types.ts` (`tags` on the stage options, `FlowChartOptions`,
  `SimplifiedParallelSpec`, the spec node) · `FlowChartBuilder.ts ·
  applyTags` + `.tag()` · `StageNode.tags` · `memory/types.ts ·
  CommitBundle.tags` · `FlowchartTraverser.executeNodeStep` (stamp) ·
  `StageContext.commit` (`tagsFragment()` on both paths) ·
  `FlowChartExecutor.resume` (the synthetic resume root carries the paused
  stage's tags) · `RuntimeStructureManager.stageNodeToStructure` (run-time
  resolved nodes advertise theirs) · `time-travel/tagStops.ts`, exported
  from `footprintjs/trace`. Design: `docs/design/2026-09-declared-tags.md`.

## [9.20.0] - 2026-09-10

### Fixed

- **A subflow's served state is its own redacted mirror — the 9.19.0 law's
  one named limit is closed.** `getSnapshot({ redact: true })` served
  `subflowResults[*].treeContext.globalContext` (and its `#n` twin) as the
  subflow's RAW heap: the redacted mirror existed only at the run level
  (`ExecutionRuntime.enableRedactedMirror`), while `SubflowExecutor` built
  each nested runtime bare and read its heap into the result. A served
  subflow state is retained, so the law said it must be covered; the scope
  guide called it a "Known limit", and agentfootprint's `servableSnapshot`
  had to work around it — refold every subflow's final state from its
  scrubbed `history` with `stateAt` before a model could see a snapshot. The
  exit event had the same hole: `onSubflowExit`'s `outputState` handed every
  FlowRecorder the raw heap (the exit twin of the `Input:` line 9.19.0
  closed).

  Fixed at the root, one owner, no second scrub. `SubflowExecutor` now
  enables the mirror on the nested runtime exactly when the parent-mount
  context carries the run's mirror — the same triplicated hop the four dials
  and the rule take (root install · `createNext`/`createChild` · the subflow
  push): on the runtime's first root, so the seed commit lands in the mirror
  as the placeholder, and again on the final root after the seed swap. The
  mirror's final state is remembered BESIDE the raw result, by identity
  (`engine/handlers/servedSubflowResults.ts`), and `getSnapshot({ redact:
  true })` serves it as one substituted object per mount — the path key and
  the `#n` twin still point at ONE object. `onSubflowExit.outputState`
  carries the same served view. Unchanged: the plain `getSnapshot()` (the
  subflow's live heap, the traverser's own record), the checkpoint's
  `subflowStates` (real values — resumption replays them; a resumed subflow
  re-seeds through the same commit, so its mirror is seeded too), the
  run-level mirror, and every no-policy byte — with no policy there is no
  mirror and the served objects ARE the plain ones. Cost: one `SharedMemory`
  per subflow run, only under a policy.

  Example — policy `{ keys: ['apiKey'], fields: { profile: ['auth.token'] } }`,
  an outer chart mounting `sf`, which mounts `sf-deep`, both seeded by
  `inputMapper`:

  ```typescript
  const served = executor.getSnapshot({ redact: true }).subflowResults!;
  served['sf/sf-deep'].treeContext.globalContext;
  // { apiKey: 'REDACTED', profile: { name: 'Ada', auth: { token: 'REDACTED' } }, deepSeen: 26 }
  executor.getSnapshot().subflowResults!['sf/sf-deep'].treeContext.globalContext.apiKey;
  // 'sk-live-…'  — the live heap, as before
  ```

  For every entry, under both encodings, the served state equals
  `stateAt({ history, initialState }, history.length - 1).state` — the fold
  agentfootprint computed by hand is now what the library serves. Pinned by
  `test/lib/engine/security/redaction-subflow-served-state.test.ts` (served,
  dual keys, checkpoint, resume, loop iterations, exit event, allocation
  count); the no-policy served view is byte-identical to 9.19.1 by
  `test/lib/engine/scenario/redaction-no-policy-byte-identity.test.ts`, whose
  reference was generated on the 9.19.1 tree before the change.

## [9.19.1] - 2026-09-10

### Fixed

- **A stage that only re-spells a deleted key no longer commits the whole
  container.** Found by CI's random property seed (768917944) in the 9.19.0
  publish job; it reproduces identically on 9.18.1, so it is a latent defect
  in the net-change filter, not a 9.19.0 regression. The library has two
  spellings of "this key is deleted": `'full'` mode flattens `delete` into an
  own `key: undefined`, `'delta'` mode's `delete` verb removes the key — and
  every consumer (JSON, the fold, `commitValueAt`, the mirror) reads them as
  one state. `deepEqual`, the ONE net-change compare every commit runs, told
  them apart: it counted own keys, so `{}` and `{ 0: undefined }` were "a
  change". A staged `delete` writes the own-`undefined` spelling into the
  working copy, so under `'delta'` — whose committed state really lacks the
  key — deleting an ABSENT key inside a container the stage also re-wrote
  (unchanged) made the container "survive" the filter and commit as a `set`
  of a shell: a delta bundle of 16 bytes where the full bundle was 9, and the
  very shell delta mode exists to remove was written back into its state.
  Example (base `{}`): stage 1 sets `a.0.p = 0` and deletes `list`; stage 2
  deletes `a.0` and re-writes `c`; stage 3 re-writes `a` unchanged, deletes
  `a.0` again and sets `b = 0`; stage 4 deletes `a` — stage 3's delta bundle
  carried `a: {}` beside `b: 0`. Fixed at the root, not the symptom:
  `deepEqual` now compares the keys that HOLD a value, so an own `undefined`
  is absent (arrays are untouched — a slot is a slot). Both encodings inherit
  it: a `'full'` stage that deletes an absent key inside a container it
  re-wrote now commits nothing there either — the committed state is the same
  through every consumer's lens, and "a stage that changes nothing commits an
  empty patch" is what the filter has always promised. Verbs, replay and the
  four verb switches are unchanged. Pinned as `REGRESSION (seed 768917944)`
  in `test/lib/memory/property/delta-replay-equivalence.test.ts`; property
  (c) keeps its claim.

## [9.19.0] - 2026-09-10

### Fixed

- **A redaction policy now covers everything the run retains or serves — one
  owner, one law.** Found by agentfootprint on 2026-09-09: its
  `flowchartAsTool({ redact })` builds the view a model may see from the
  footprintjs record, so it could only ever be as clean as the log — and two
  reviewers measured five paths on 9.18.1 where a policy-redacted value
  reached the record in plaintext (each pinned there as a "substrate limit").
  All five were paths that wrote or read PAST the `ScopeFacade`, which held
  the verdict alone: a subflow `outputMapper` merged back through
  `StageContext` directly, so the PARENT log took a redacted key verbatim
  (`SubflowInputMapper.applyOutputMapping`); an `inputMapper` seed was
  committed by the subflow's runtime as its unscrubbed `history[0]`
  (`seedSubflowGlobalStore`) and narrated as an `Input:` line with its raw
  value (`SubflowExecutor`); a tracked READ cloned the plaintext into
  `executionTree.*.stageReads` (`StageContext.getValue`); and a `fields`
  (dot-path) policy scrubbed the value handed to recorders only, while the
  commit took the key-level verdict and the log and mirror kept
  `profile.auth.token`. The fix is at the root, not a sixth hand-written
  scrub: the verdict has ONE owner, `RedactionRule` (`memory/redaction.ts`),
  built per run, installed on the root `StageContext` and inherited like the
  dials — and `StageContext` asks it on every staged write and every tracked
  read. A facade write, a subflow seed, a merge-back and a resume re-seed are
  now the same case; `fields` register the paths inside the value so
  `redactPatch` scrubs them in the log and the mirror; the facade and the
  narrated seed use the same rule. Two smaller paths closed by the same
  funnel: `$update` on a redacted key (its merge never carried the flag into
  the log) and a read of a policy key that was seeded before the run and never
  written through the facade (recorders saw it raw).

  **The law**, in one line: a policy covers the commit log (both encodings),
  the redacted mirror, `stageReads`/`stageWrites`, recorder events and the
  narrative, a subflow's seed and merge-back — and NEVER the live heap the run
  computes on (`getSnapshot().sharedState`, what stage functions read) nor
  the resume checkpoint (resumption must replay real values; it is handed to
  the runner, never served). Both halves are pinned by
  `test/lib/engine/security/redaction-one-law.test.ts`; `stateAt` and the
  time-travel cursor fold the scrubbed log to exactly the mirror's view.

  **A consumer that sets no policy sees no change** — the fixture chart in
  `test/lib/engine/scenario/redaction-no-policy-byte-identity.test.ts` runs
  byte-identical to the bytes 9.18.1 produced, both encodings. **A consumer
  with a policy now sees MORE scrubbed**: that is the fix. Example —
  `executor.setRedactionPolicy({ keys: ['apiKey'], fields: { profile: ['auth.token'] } })`
  on a chart whose subflow is seeded with both keys: the parent log, the
  subflow's `history[0]`, its narrative `Input:` lines, every `stageReads`,
  the mirror and `stateAt(...)` all hold `REDACTED` / `[REDACTED]` for
  `apiKey` and `profile.auth.token` (with `profile.name` intact), while
  `getSnapshot().sharedState.apiKey` and the resume checkpoint hold the real
  value. `RedactionRule` and `RedactionVerdict` are exported from
  `footprintjs/advanced`; `RedactionPolicy`/`RedactionReport` keep their
  public path. Placeholders are unchanged (`'REDACTED'` in the log and
  mirror, `'[REDACTED]'` everywhere else). The mirror's SEED is scrubbed too:
  a policy key that arrives by `initialContext` / `defaultValuesForContext`
  (or by a checkpoint's `sharedState` on a cross-executor resume) and is
  never re-written is served as the placeholder, not in plaintext.

  **One served surface stays raw, by construction:**
  `subflowResults[*].treeContext.globalContext` (and its per-iteration `#n`
  twin) is the subflow's own heap even under `getSnapshot({ redact: true })`
  — only the run-level runtime keeps a mirror. Its `history` IS scrubbed, so
  the workaround is to fold that history with `stateAt` (what agentfootprint's
  `servableSnapshot` does); a per-subflow mirror is the follow-up.

## [9.18.1] - 2026-09-10

### Fixed

- **A cyclic value no longer blows the stack at commit.** The engine's own law
  on state values is "must survive `structuredClone`" — and `structuredClone`
  PRESERVES cycles, so an object that references itself is a legal value, not
  an out-of-contract one. Two walkers on the commit path did not honour that:
  `deepEqual`, the net-change filter every commit runs, and `deepSmartMerge`,
  the `merge` verb (staged at write time, replayed by the fold and by
  `commitValueAt`). Both recursed without a cycle guard, so a tool schema whose
  object pointed at itself, reaching a subflow's `outputMapper`, threw
  `RangeError: Maximum call stack size exceeded` — caught per stage under one
  chart shape (the run limped on with the write LOST) and fatal under another.
  Found by an agentfootprint reviewer on 2026-09-09. `deepEqual` now keeps the
  object pairs it is already inside and treats a re-entered pair as equal (the
  structural answer, lodash `isEqual` semantics); `deepSmartMerge` hands a
  re-entered source the value it is already building, so the merged value
  mirrors the cycle. Acyclic inputs see no change — same key, array, `NaN` and
  `null` rules, and a shared (DAG) reference is still compared or merged
  against its own counterpart at every occurrence. The commit log, the live
  state, `stateAt` and the time-travel cursor all hold and fold the cycle
  intact. Example: `scope.tools = [schema]` where `schema.self === schema`, then
  a subflow's `outputMapper` re-emits the schema — the run completes and the
  bundle records it.

## [9.18.0] - 2026-09-08

### Added

Five edges of the reader's cursor, reported by the two consumers that built on
9.17.0 in the same week — a FILTERING strategy (keep the stages a domain
classifies) and a cursor that maps its own position list into stops. All five
are additive: a 9.17.0 consumer compiles and behaves identically, and
`test/lib/time-travel/backcompat.test.ts` pins that with a 9.17.0-shaped
strategy — hand-rolled bookend guard, hand-rolled re-partition, a domain kind
re-derived from the id at every read — left untouched and asserted stop for
stop against the composed one (`[start -1..0] [LLM turn 1..1] [Tool call 2..3]
[end 3..3]`, both ways).

- **`Stop.meta` — a strategy's own vocabulary rides ON the stop.** `Stop.kind`
  is the port's vocabulary (`'commit' | 'mount' | 'start' | 'end'`), so a domain
  strategy had nowhere to put its own classification and re-derived it from
  `runtimeStageId` at every read — a second run of the classifier that just
  ran. `Stop<TMeta>`, `TimeTravelStrategy<TMeta>`, `TimeTravel<TMeta>`,
  `Move<TMeta>` and `TimeTravelOptions<TMeta>` are now generic over that
  vocabulary, defaulting to `unknown` so every bare 9.17.0 signature still means
  what it meant. The port assigns `meta` no meaning: it never reads, validates
  or branches on it, and copies it verbatim through `timeTravel`, `jumpTo`,
  `drill` and marks — BY REFERENCE, never cloned or frozen, so a mutation
  through one holder is visible to every other. Absent — not `null` — on every
  stop `commitStops` makes, and never inherited by `filterStops`: a `true`
  decision over an axis that already carries another strategy's `meta` keeps
  the stop and drops that meta, so a `Stop<TMeta>` only ever carries the
  decision's own.

- **`Stop.prologue` — what `'start'` folds on a FILTERING axis, said out
  loud.** The docs described `'start'` as the fold BASE. A strategy that filters
  cannot honour that and also partition the log: the commits before its first
  surviving stop have to fold somewhere, and `'start'` is the only place.
  Measured by the consumer: `commitStops`' start folds `-1..-1` and 0 keys; the
  milestone axis's start folds `-1..0` and 32 keys, `userMessage` among them —
  so a renderer keying on `kind === 'start'` for "the run's raw base" was wrong
  on every derived axis. The decision is a FLAG, not a fifth kind: widening
  `StopKind` would hand a compile error to every consumer with an exhaustive
  `switch` over it. `StopKind`'s docs now state both meanings, and
  `prologue: true` marks a start that absorbed stages the axis does not show.
  A reader that means "before anything ran" checks
  `kind === 'start' && !prologue`. On the example chart, the per-stage start
  has 0 keys; the beat axis's start folds `-1..1`, has 3 keys (`tenant`,
  `needle`, `prepared`), equals `stateAt(snapshot, 1)`, and carries the flag.

- **`splitAxis` and `filterStops` — the `[start, …stages, end]` shape, stated
  once.** `commitStops` returned a bare `Stop[]`, so the shape every composer
  relied on was not pinned and each defended it with its own runtime kind check
  and a mocked-substrate test. The invariant is now documented on
  `commitStops`, pinned here on an empty log, a one-stage log, a log with a
  mount and a fork, and READ by `splitAxis`:
  `{ ok: true, start, stages, end }` or
  `{ ok: false, reason: 'empty' | 'not-bookended', kinds }` — two different
  facts, kept apart, because a composer that treats them alike reports a broken
  strategy as an empty run. `filterStops(stops, keep)` does the whole
  composition on top of it — guard, filter, re-partition so the survivors give
  the log back (nothing orphaned; `stateAt(stop)` stays "what the next kept
  stage read"), `label`/`meta` on the survivors, `prologue` on the start — so a
  composing strategy is now one expression. A run the strategy recognises
  nothing in yields the two bookends and nowhere to stand, NOT the `[]` that
  says the log was empty.

- **`timeTravel([paused, resumed])` — a pause and its resume read as ONE
  axis.** A cross-executor resume produces two snapshots; the resumed run has a
  fresh runtime, so its `commitLog` restarts at 0 and holds only the
  post-resume commits (`seed#0@0 prepare#1@1 gate#2@2` on one side,
  `gate#3@0 finish#4@1` on the other). The cursor had no way to read the second
  as a continuation of the first, so a reader scrubbing a resumed run silently
  saw half of it. An ARRAY of sources is now a chain: one axis, one pair of
  bookends, 7 stops for those 5 bundles, steps `0…6` running across the seam.
  THE HONEST BIT: commit indices are RUN-LOCAL and the library invents no
  global one — `commitIdx` keeps indexing its own source
  (`-1, 0, 1, 2, 0, 1, 1`), every stop carries `sourceIdx`, `stateAt` folds in
  that source (a leg with its own `initialState` restarts the fold from it — on
  a resume that base IS the state at the pause) and reports `sourceIdx` too,
  `changedSince` walks a seam-crossing range leg by leg, and `drill` looks in
  every leg. The strategy is called once per source with that source's own log
  and tree, so no strategy ever knows it is chained. THE REFUSAL: a chain that
  is not in run order or not from one lineage is refused with a reason, never
  guessed at. Three checks, each with its own reason: no `runtimeStageId` in
  two legs (a same-executor resume, whose one snapshot already holds both
  halves, fails with "sources 0 and 1 both record 'gate#2'"); each leg's first
  execution index past the previous leg's last (the counter is never reset on
  resume, so `[resumed, paused]` fails with "source 1 starts at execution
  index 0, which is not past source 0's last (4)" and an unrelated run with
  "both record 'seed#0'"); and each leg's `initialState` deep-equal to the
  state the legs before it fold to — on a resume the fresh runtime is seeded
  from the checkpoint, so that base IS the state at the pause, and a leg from
  some OTHER lineage whose indices merely happen to be higher fails with
  "source 1's initialState is not the state source 0 folds to". The third
  check runs only where the record allows it (the later leg carries an
  `initialState`; the earlier legs fold from a real base with no unreadable
  rows; redacted paths are excluded) and is otherwise SKIPPED, not faked — an
  older recording with no base is chained on the two index checks alone and
  the fold's `basis` says so. Stops' index ranges partition each LEG and never
  span the seam. A one-element array is the plain cursor, and a single source
  has no `sourceIdx` anywhere — the 9.17.0 shape exactly.

- **A stored recording needs no cast.** `TimeTravelSource.commitLog` was
  `readonly CommitBundle[]`, but a recording arrives as parsed JSON and a
  careful consumer types its rows `readonly unknown[]`; one consumer documented
  the resulting cast as a known wart. `commitLog` / `history` now take
  `readonly unknown[]` and `executionTree` / `subflowResults` take `unknown`,
  with the narrowing done inside, per bundle, where the fold reads one. A live
  snapshot is assignable exactly as before and the clean path returns the same
  array — nothing copied, nothing allocated, byte-identical folds. A row that
  is not a bundle becomes a GAP that KEEPS ITS INDEX: it contributes no state,
  gets no stop, and is reported in `FoldedState.skipped` as `{ index, reason }`
  (`'not an object (null)'`, `'runtimeStageId is missing, not a string'`,
  `'trace is a object, not an array'`). With row 1 of a 3-row recording
  replaced by `null`, the axis is `start@-1 → collect@0 → report@2 → end@2` —
  `report` is still at 2 — and the fold through 2 reports
  `skipped: [{ index: 1, reason: 'not an object (null)' }]` with `verdict`
  honestly absent; a fold that stops before the gap reports nothing. A tree or
  a results map that is not an object is read as absent (the mount is then
  found by the shape heuristic, and `drill` answers `undefined`).
  A row with no `trace` at all — the one field every reader WALKS — is a gap
  too (`'trace is missing, not an array'`), never a crash in the fold.
  `FoldSource` takes the same all-optional shape as `TimeTravelSource`, so a
  consumer's stored-recording type (`commitLog?: readonly unknown[]`) drives
  `stateAt` and `timeTravel` alike. `TimeTravelSource` and `FoldSource` are
  INPUT shapes: nothing typed as one promises its rows are bundles, so code
  that reads `CommitBundle` fields back out of such a value must narrow each
  row with `isCommitBundle` first.
  `isCommitBundle(row)` is exported for a consumer that wants to validate rows
  itself. `skipped`, `sourceIdx`, `meta` and `prologue` are ABSENT as keys on
  every clean, single-source, shipped-strategy result — a 9.17.0 consumer that
  enumerates a stop or a fold sees no new key.

Exported from `footprintjs/trace`: `filterStops`, `splitAxis`,
`isCommitBundle`, and the types `StopFilter`, `BookendedAxis`, `AxisSplit`,
`AxisRefusal`, `LogGap`. Three new examples under
`examples/post-execution/time-travel/` (03 compose a strategy · 04 chain a
pause and resume · 05 a stored recording needs no cast). `test/lib/time-travel`
grows to 126 tests across 8 files.

## [9.17.0] - 2026-09-06

### Added

- **A reader's cursor over a finished run — `timeTravel()`, in
  `footprintjs/trace`.** Time travel here is READ-TIME: the run is over, the
  commit log is the trace it left, and the cursor is a reader moving over that
  trace with a fold at each stop. It is not the engine's walk, and it never
  becomes a second live cursor — nothing in it can resume, re-run or edit an
  execution.

  Every consumer was already doing this, separately: the same commit-index
  arithmetic, hand-written against the same log, in a why-panel, a flow view and
  a dashboard — three implementations that could disagree about which stage a
  step number meant. This is that arithmetic once, in the library that owns the
  substrate.

  ```ts
  import { timeTravel } from 'footprintjs/trace';

  const cursor = timeTravel(executor.getSnapshot());
  cursor.jumpTo('score-risk#7');
  cursor.changedSince();          // ['riskScore', 'tier'] — read off the traces
  cursor.stateAt().state;         // the state that stage left, detached + frozen
  cursor.mark('where it went wrong');
  const inner = cursor.drill('sf-payment#7');   // its own cursor, its own log
  ```

  Five laws hold everywhere, and each is pinned by a test:

  - **One cursor.** `drill()` returns a SEPARATE cursor over a subflow's
    separate log — never a second position on this axis. A stop inside a subflow
    is not a stop of the outer cursor, and jumping to one is a miss.
  - **A miss never moves.** `Move` is `{ moved: true, from, to }` or
    `{ moved: false, reason: 'clamped' | 'miss' | 'empty', at, nearest }`. A bad
    id leaves the panel showing exactly what it showed before, with a reason and
    the nearest stop it could name.
  - **A fold result is detached.** `stateAt()` returns a deeply frozen clone that
    shares nothing with the engine, and says how it was derived.
  - **Marks live beside the log.** They are the reader's notes; nothing writes
    them into the commit log or the snapshot. A mark names its stop by
    `runtimeStageId`, not by step number, so it survives a change of strategy.
  - **Stops are derived from the recorded log.** A strategy reads what the run
    actually committed; it never re-walks the execution tree to synthesize a
    stop for something nobody recorded. That is what keeps a custom strategy
    honest when it replaces the one shipped here.

- **`stateAt(snapshot | subtree, commitIdx)`** — the fold, on its own. Replays
  the log from its base through `applySmartMerge`, the same verb switch the live
  commit uses (no fifth verb-switch replica). Accepts a run snapshot
  (`commitLog`) or a subflow subtree (`history`), a live one or one
  round-tripped through JSON. The result carries its own honesty:
  `basis: 'initial+log'` when the real fold base was available and
  `'log-only'` when it was not, plus `redacted` / `redactedPaths` where the
  engine scrubbed values at write time — a partial answer that says it is
  partial, never a silent one.

- **`commitIndexOf(log, runtimeStageId)` and `buildCommitIndex(log)`** — the
  address translation between the id an event carries and the index every
  commit-log query speaks. FIRST occurrence wins, because a subflow mount and a
  parallel fork child each commit more than one bundle under one id and a cursor
  asks where a stage *starts*.

- **`TimeTravelStrategy` — how stops are derived is a seam.** footprintjs ships
  exactly one strategy, `commitStops` (one stop per executed stage, with
  `'start'` / `'end'` bookends), because that is the only stop grammar the
  substrate itself knows. A consumer with a richer vocabulary supplies its own
  and gets the same cursor over it; a drilled cursor inherits it.

- **`RuntimeSnapshot.initialState`** — the commit log's fold BASE now travels
  with the log, deeply frozen and fully detached. Bundles are diffs, so the log
  alone could never rebuild a value seeded before the run and only merged since;
  the base was private to the engine, so an offline consumer could not fold at
  all. A subflow carries its own alongside its own log
  (`SubflowResult.treeContext.initialState`, surfaced as
  `getSubtreeSnapshot(...).initialState`). The field is **optional by type and
  always present at runtime**: every snapshot the engine builds carries it (so a
  live fold reports `basis: 'initial+log'`), while code that CONSTRUCTS a
  snapshot literal — a UI fixture, a stored 9.16.x trace — still compiles and
  folds honestly as `'log-only'`. **`getSnapshot({ redact: true })` OMITS it**:
  the base is the raw pre-run seed and no redaction policy ever touched it
  (policies scrub writes, and nothing wrote the base), so serving it on the
  safe-to-share view would hand back the original value of a seeded secret a
  later commit had scrubbed. A redacted snapshot therefore folds
  `basis: 'log-only'` — the channel built for exactly this.

### Fixed

- **The event log's fold base now matches the state the run actually starts
  from.** `EventLog` was seeded with `initialContext` alone, leaving
  `defaultValuesForContext` out of every replay — so a fold could not reproduce
  what a stage saw. It is now seeded from the store's own starting state
  (`initialContext` merged with the defaults), and normalised to `{}` instead of
  `undefined`, which is what made `materialise()` throw on the first `set` for a
  run with no initial context.

### Changed

- **`getSnapshot().commitLog` is now a detached, frozen array.** It used to
  alias `EventLog`'s live internal array: a snapshot taken mid-run kept growing
  under whoever held it, and a consumer could splice the engine's own history. A
  snapshot is a fold result, and a fold result does not change under its holder.
  The bundles inside are the engine's own objects, immutable after record, and
  are not copied. `getCommitCount()` still reports the same number the array
  has. Every consumer in the repository was checked first; none read the log
  through the alias, and the full suite passes unchanged.

## [9.16.1] - 2026-08-30

### Fixed

- **`decide()` called without a default threw a TypeError (9.16.0 only).** The
  third argument is required by the type, and JavaScript callers omit it anyway:
  a rule set that covers every case never consults a default, and before 9.16.0
  that missing argument simply landed on `evidence.default` as `undefined`.
  9.16.0's normalization understood a string or the new object and nothing else,
  so those call sites started failing inside the decider with `Cannot destructure
  property 'branch'`. Now only the object form is unwrapped and every other value
  — `undefined` included — passes through as the branch, exactly as before.
  Found by a downstream test suite the same afternoon; pinned here by two tests
  that call `decide()` with two arguments.

## [9.16.0] - 2026-08-30

### Added

- **`decide()` can name its DEFAULT branch — `{ branch, label }`.** Every branch
  of a decider is named by the rule that chose it: the rule carries a `label`,
  and that label travels out on the decision evidence for narratives, audits and
  anything downstream that publishes what each outcome means.

  The default branch is chosen by no rule. It fires precisely when every rule
  failed, so no rule exists to carry its name — it was the one branch evidence
  could not name, and a meanings map generated from evidence had its hole
  exactly where the run's own outcome sat.

  The default is now declared beside the rules it competes with:

  ```ts
  decide(scope, [
    { when: { riskScore: { gt: 80 } }, then: 'quarantined', label: 'Risk above the quarantine line' },
    { when: { riskScore: { gt: 50 } }, then: 'flagged',     label: 'Risk above the review line' },
  ], { branch: 'protected', label: 'No rule fired — asset stays protected' });
  //  ↑ was: 'protected'
  ```

  The label lands on `DecisionEvidence.defaultLabel` and rides the same evidence
  channel as every other label — no second declaration surface, nothing a caller
  can assert that the rules did not say. The narrative prints it the way it
  prints a matched rule's:

  ```
  [Condition]: No rules matched, fell back to default "No rule fired — asset stays protected": Protect.
  ```

  It is recorded on **every** decision, including runs where a rule won: the
  default's meaning belongs to the decider, not to the run, and emitting it only
  on the fallthrough would make a harvested meanings map appear and disappear
  with the data.

  New exported type `DefaultBranch = string | { branch: string; label?: string }`.
  The bare string is untouched, byte for byte: `defaultLabel` is absent — not
  `undefined` — from evidence produced by a string default, pinned by test.
  `select()` takes no default and is unchanged.

  Example: `examples/build-time-features/decide-select/05-default-label.ts`

## [9.15.1] - 2026-08-18

### Fixed

- **"./package.json" is reachable through the exports map.** A downstream archive
  format stamps the engine version into every recording by resolving
  `footprintjs/package.json` — and an exports map without that entry seals the
  manifest, so the stamp read `unknown`: honest, never false, and needlessly so.
  One line; nothing else changes.

## [9.15.0] - 2026-08-05

### Added
- **Per-stage declarative retry, recorded as evidence — `.retry({ attempts,
  backoffMs, retryOn })`.** A retry hand-rolled inside a stage function works,
  and it is invisible. The narrative shows one stage, the commit log shows one
  entry, and the two failed calls that happened first left no mark anywhere —
  so when someone later asks why a run took four seconds, the trace has no
  answer. That is an unexplained behaviour in a library whose whole thesis is
  that nothing invisible happens.

  Declared on the stage instead, every attempt is part of the record. Each
  failed attempt that is followed by another fires a new
  `FlowRecorder.onStageRetry` event carrying the attempt number, the ceiling,
  the wait, and the structured error — and the narrative renders it IN ORDER,
  inside the stage, between the attempts' own reads and writes:

  ```
  Stage 2: Ask the rate service for today's conversion rate.
    Step 1: Read currency = "EUR"
    [Retry]: attempt 1 of 3 at Fetch rate failed (service unavailable). Waited 100ms…
    Step 3: Read currency = "EUR"
    Step 4: Write rate = 1.09
  ```

  **What an attempt is.** A failed non-final attempt's staged writes are
  DISCARDED — nothing was applied, so there is nothing to roll back, and the
  next attempt starts from committed state rather than from the wreckage of the
  last try. The FINAL attempt keeps the shipped law exactly: on success it
  commits, on failure it commits what it wrote and rethrows. Commit-on-error is
  untouched, and a chart with no policy is byte-identical to before.

  **Attempts are internal to one stage execution** — one `runtimeStageId`, one
  execution index, one commit bundle, however many times the function ran.
  Retries do not consume loop iterations.

  **Never retried:** a pause (neither `addPausableFunction` nor `interrupt()` —
  both suspend the run rather than fail), a cancelled run, or `$break()`. A
  `retryOn` predicate that throws is treated as "do not retry", so a broken
  gate can never become an endless loop.

  **The arithmetic is exact, and documented:** an exhausted policy emits
  `attempts - 1` retry events then one error event; a `retryOn` that declines
  emits zero retry events and one error event. There is no event for "the
  policy chose not to act" — the error event already says everything.

  Declare it with `.retry(policy)` after `start` / `addFunction` /
  `addStreamingFunction` / `addPausableFunction`, via `flowChart(…, { retry })`
  for the first stage, or through the `retry` option on `addDeciderFunction`,
  `addSelectorFunction`, `addFunctionBranch`, `addPausableFunctionBranch` and
  `addListOfFunction` children — the sites where a chained modifier would be
  ambiguous about which stage it meant. The builder refuses a policy that could
  never fire (a subflow mount, a `addParallelForEach` fan-out, a loop
  reference) or that would silently land on the wrong stage, rather than
  accepting it and doing nothing.

  The declared attempt count also lands on the built spec as `retryAttempts`,
  so a visualiser can show that a stage retries. It carries the COUNT only —
  `backoffMs` and `retryOn` can be functions, which a JSON-safe spec cannot
  hold.

  Backoff is a plain awaited timer, cancelled by the run's `AbortSignal`. It is
  not a pause: a chart cannot be checkpointed in the middle of a backoff.
  Per-stage timeouts are deliberately out of scope for this release. Each
  attempt gets a fresh scope — which is what makes attempt isolation real — so
  scope-channel `onStageStart` fires once per attempt and `onStageEnd` only for
  an attempt whose function returned, the same shape a failing stage already
  has today.

  Guide: [docs/guides/error-handling.md#declarative-retry](./docs/guides/error-handling.md#declarative-retry).
  Examples: `examples/runtime-features/retry/`.

## [9.14.1] - 2026-08-03

### Fixed
- **A structured value read back through `scope.x` serialized to `{}` — and a
  copy of it COMMITTED `{}`.** A consumer merged an object-of-objects into a
  parent key from a subflow's `outputMapper`, read it back in the next stage,
  and got an empty object. `$getValue('x')` returned the real record, so they
  worked around it by reading through `$getValue` everywhere.

  **This was not only a read bug.** Assigning a proxied value to another key
  (`scope.copy = scope.results`) unwraps it by round-tripping through JSON — the
  same code path — so the truncated object is what landed in the commit log and
  in shared state. Anyone diffing recordings across 9.14.0 → 9.14.1 will see
  those committed bytes change from corrupt to complete. That is the fix, not a
  regression, but it is a real change in what a recording of the same chart
  contains.

  The cause was a cycle guard that never checked for a cycle. Reading a nested
  object mints a new proxy on every property access, which defeats
  JSON.stringify's identity-based cycle detection, so `toJSON` returned a copy
  with every object-valued member stripped — unconditionally, at every depth.
  Enumeration was never affected: `Object.keys`, spread, `for...in` and
  `Object.entries` were always correct, which is exactly why this survived 238
  reactive tests. Every one of them used flat objects whose leaves were
  primitives, and the single `JSON.stringify` test asserted the loss as if it
  were intended.

  Now `toJSON` hands JSON.stringify the underlying state object **by reference**
  when it is acyclic — no clone, and `JSON.stringify(scope.x)` is byte-identical
  to `JSON.stringify(scope.$getValue('x'))` by construction. Only a back-edge to
  an ancestor is pruned, so circular scope values still never throw through the
  property path (a diamond is not a cycle and serializes on both paths). The
  write-path round-trip is otherwise untouched: Date still becomes a string, Map
  still becomes `{}`, undefined members still drop, and `$setValue` is still the
  bypass. What no longer happens is members going missing.

- **Serializing the scope no longer records a read of a key no chart ever
  names.** `JSON.stringify(scope)` asks the object for a `toJSON` method before
  serializing it. That question comes from the JS runtime, but it arrived at the
  scope as a state lookup, so `toJSON` was recorded as a tracked read — in the
  `onRead` channel and, under `writeProvenance: 'reads-prefix'`, inside
  `TraceEntry.readKeys`, where `causalChain` and `sliceForKey` then carried it.
  Recorded read sets now shrink by exactly that phantom and nothing else: the
  keys `JSON.stringify` genuinely reads are still recorded, because their values
  really do flow into the output. Strictly less noise, never less truth.

  The suppression is proof-based rather than name-based. A state key literally
  called `toJSON` is legal, and when the key actually exists the read is real and
  stays tracked; when the scope cannot answer the existence question silently,
  the read stays tracked too. A key is never dropped from tracking on a guess.

## [9.14.0] - 2026-08-02

### Added
- **A fan-out whose branch COUNT comes from the data — `.addParallelForEach()`.**
  Every parallel shape in the library until now named its branches when you
  wrote the chart. Two independent consumers arrived at the same wall from
  opposite directions: the work to do is decided at run time — three chunks
  make three branches, ten make ten — and the only way to express that was to
  hand-roll a fork whose children the chart could not see, which meant the
  trace could not see them either.

  ```ts
  .addParallelForEach('Review each chunk', 'review-chunks', {
    items: (scope) => scope.chunks,
    branch: (chunk, i) => buildReviewChart(chunk, i),
    maxBranches: 8,
    into: 'reviews',
  })
  ```

  **Each branch is a real subflow, and that is the whole design.** A branch
  gets its own isolated runtime, its own commit log, and an address in the
  grammar that already ships: `review-chunks~2/score#14` — a subflow path
  segment, not a new kind of id. Which means `parseRuntimeStageId`,
  `causalChain`, `sliceForKey` and `forwardSliceForKey` read branch commits
  with **zero changes**, because the id shape IS the shipped shape. That claim
  is cheap to assert, so it is proven by tests against a real fan-out's real
  log rather than asserted in prose. The item each branch received is seeded
  into that branch's scope, so it appears in the branch's own commit log —
  provenance, instead of a value hidden in a closure.

  **Two laws you can rely on.** `into` receives ONE ordered array write, and
  `into[i]` is branch `i`'s result in ITEMS order no matter which branch
  finished first (property-tested against random completion interleavings) —
  because a results array that reorders itself under load is a bug you find in
  production, not in review. And `maxBranches` is REQUIRED: an unbounded
  fan-out driven by model output or an upstream API is a resource attack, so
  there is deliberately no default to forget. Items past the ceiling do not
  run and the truncation is written into the stage's own log — bounded, and
  stated. A failing branch follows the failure policy the rest of the
  library's parallelism already uses: `failFast` rejects the stage, best-effort
  runs them all and leaves `undefined` in the failed branch's slot so the
  array still lines up with your items one for one.

  **`~` is now reserved in subflow ids.** The generated branch segment is
  `<stageId>~<index>`, and a hand-authored id carrying the same marker could
  collide with it. This codebase already tolerates a deliberate id-collision
  class (loop-ref stubs), so a collision here would not crash — it would
  silently mis-attribute a trace, which is worse. The builder now refuses `~`
  in user-authored subflow ids and in the `addParallelForEach` id, at BUILD
  time, with a sentence naming the reservation and the design doc. Charts that
  do not use the character are byte-identical; the character appears in no id
  in this repo or any known consumer, which is how it was chosen.

- **`interrupt(scope, { reason, expects? })` — pause from inside ANY stage
  body, and get the answer back at the same call site.** `addPausableFunction`
  splits a stage you declared pausable into execute/resume halves. That shape
  fits an approval gate; it does not fit a stage that gets halfway through its
  work and discovers it needs to ask something. Now:

  ```ts
  const approval = interrupt<{ approved: boolean }>(scope, {
    reason: `Approve a $${scope.amount} refund?`,
    expects: { approved: 'boolean' },
  });
  scope.approved = approval.approved;   // reached only after resume()
  ```

  It works in every stage kind — linear, decider branch, selector branch, fork
  child, subflow body — because the conversion happens at the one boundary
  every stage function passes through. It reuses the shipped pause machinery
  end to end: one `FlowchartCheckpoint` (no second shape), your payload as its
  `pauseData`, `run()` returning the existing paused outcome, the same
  detached clone you already persist. A pause under a decider keeps its
  invoker, and `executionIndex` stays monotonic across the resume.

  **The law that decides how you write the body: resume re-enters the stage
  from its TOP.** Stages are atomic — a stage that stopped mid-body has no
  half to resume into — so everything before the `interrupt()` call runs
  again. This is the same law `resumeOnError` states, and it is stated here
  too, in the docs and in the JSDoc, because leaving it implicit once already
  cost a consumer a debugging session. Keep the half before the call
  idempotent; put what must happen exactly once after it.

  One honest limitation, documented and pinned rather than hidden: an
  `interrupt()` inside a `parallelForEach` branch pauses correctly but cannot
  be resumed — a generated branch is not in the static chart, which is what
  `resume()` rebuilds its cursor against. It refuses loudly through the
  existing "stage not found in flowchart" message. A silent partial resume
  would be the failure this whole design was built to avoid.

### Changed
- `SerializedPipelineStructure` / `FlowChartSpec` / `SerializedPipelineNode`
  gain an optional `isDynamicParallel` boolean. A `parallelForEach` stage
  serializes with `type: 'fork'` — a fan-out is what it is — so every existing
  consumer renders it correctly with no changes; the flag is there for
  consumers that want to say "one branch per item". No new node type was
  introduced, following `isPausable` / `isLazy` / `isStreaming`.
- `FlowchartCheckpoint` gains an optional `pausedBy: 'interrupt'`. Absent on
  every checkpoint written before this release, which is exactly right — it
  records HOW the pause was raised so `resume()` picks the matching re-entry.

## [9.13.0] - 2026-08-02

### Added
- **The forward half of variable-first slicing — `forwardSliceForKey()` and
  `keyTimeline()`** (`footprintjs/trace`). The slice layer could only answer
  backward: *why is this value what it is?* An integration running in
  production hit the other direction and had no query for it — a value was
  wrong, and the question was *who read it, and what did it feed?* (their
  words, about a recipe id flowing through a chart). The commit log already
  held the answer; nothing asked it. Reconstructing it by hand means scrolling
  a trace viewer for reads, matching them against the writes they sit between,
  and hoping you did not miss one — for every value you suspect.

  `forwardSliceForKey(commitLog, key, keysRead, options?)` answers it in one
  call, and takes exactly what the backward door takes (same anchor idiom:
  the last write, or the last write before `before`; same `KeysReadSource`
  strategies, since reads live in the execution tree, not the log). The unit
  of the walk is a **value's life**: a write starts one, the key's NEXT write
  ends it, every stage that read the key in between saw THAT value, and a
  reading stage that also wrote something carried the value onward — a `fed`
  edge, followed breadth-first under the same budgets `causalChain` uses.
  `keyTimeline()` is the flat companion: every write (with its verb) and every
  recorded read of one key in commit order, each moment carrying both join
  keys (`runtimeStageId` and `commitIdx`), and each read attributed to the
  value it actually saw.

  Where the boundary falls is a decision, not an accident: reads fire BEFORE
  their stage's commit, so a read-modify-write stage's own read belongs to the
  PREVIOUS life, and the stage that overwrites a key still read the old value.
  A read after that commit attributes to the new write, never the old. The
  timeline and the walk use one rule (a property test pins them to identical
  attribution — two doors, one truth).

  **A `fed` edge is exact only when the log can prove it.** With
  `writeProvenance: 'reads-prefix'` on, a write records the keys read before
  it, so an edge is exact — and the same evidence EXCLUDES exactly (a write
  whose recorded reads omit this key gets no edge at all). With the dial off
  there is only "this stage read that key and wrote this one", which is a
  sound over-approximation and nothing more: every such edge is stamped
  `basis: 'stage'` and the answer carries a note saying so. A conservative
  edge is never rendered like an exact one — the string projection prints
  `[conservative]` next to it.

  Absence is answered rather than shrugged at. A key this log never wrote and
  never read comes back as `missing: 'never-written'` with a note NAMING a
  bounded list of the keys it does know, because the overwhelmingly likely
  cause is a typo, and a typo must never read as "this variable has no
  history". When the log records no reads at all, that distinction is
  genuinely unavailable — so the answer says THAT instead, rather than
  implying the value went unread. A value that predates every write (initial
  state, frozen run `input`, a closure) gets a `'pre-run'` origin life with
  its own note: the reads are real, the author is outside the log.

  Serialization follows the module's existing law — a forward graph shares
  nodes exactly as a backward one does, so `JSON.stringify` on a root is still
  the wrong move. `forwardSliceToJSON()` (flat, id-referenced, linear) and
  `formatForwardSlice()` (one bounded string, honesty notes rendered) join
  `sliceToJSON` / `formatSlice`, and `formatTimeline()` bounds a key's life for
  an LLM tool. A timeline holds no live references and no sharing, so its JSON
  needs no helper — that is stated in the code rather than papered over with a
  no-op function.

  Nothing changes for existing callers: no engine change, no new capture, no
  new dial. Both directions are pure post-hoc queries over what the run
  already recorded. Thanks to the integration team who asked the question in
  the first place.

## [9.12.0] - 2026-07-28

### Added
- **`meta` on a recorder's snapshot bundle** — `toSnapshot()` may now return a
  small `meta` object, and it is copied through to
  `getSnapshot().recorders[i].meta` unchanged. It is for facts about the
  BUNDLE, not about the run: which projection of the recorder's data this is,
  how it was produced, what it deliberately left out. The row a consumer reads
  is rebuilt field by field (deliberately — a recorder must not be able to
  rename itself in a snapshot consumers index by `id`), which means anything
  the list forgot was dropped in silence, and the only place a recorder could
  say which of two bundle shapes you were holding was the prose in
  `description`. String-matching a sentence is not a thing offline readers do:
  they render the empty panel instead. `agentfootprint`'s boundary recorder is
  the case in hand — it can emit a full bundle or a content-free lean one, and
  a viewer that cannot tell them apart shows blank detail panes rather than
  saying "this recording carries structure only". Keys are the recorder's to
  choose; keep the values JSON-safe, since this rides the snapshot to disk.
  Nothing changes for a recorder that omits it: no `meta`, no key.
- **The narrative rides the snapshot** — `CombinedNarrativeRecorder` now
  implements `toSnapshot()`, so an attached `narrative()` lands in
  `getSnapshot().recorders` as `{ name: 'Narrative', preferredOperation:
  'translate', data: entries }`. It was the one built-in recorder with no
  snapshot bundle, which left every consumer holding only a frozen snapshot
  (a trace viewer, an exported run, a UI narrative panel that never sees the
  executor) with no way to read the run's story — `getNarrativeEntries()` is
  an executor method and reads only the executor's own internal narrative
  recorder. The snapshot entries deliberately DROP `rawValue`: it is a live
  reference to scope/emit payloads by contract, so carrying it would alias
  engine memory into an artifact that is supposed to be detached AND break
  `structuredClone`/`JSON.stringify` on any non-serializable payload. The
  rendered `text` already carries the value summary and `key` carries the
  scope key, so nothing a snapshot consumer can act on is lost; in-process
  consumers that need the live value keep using `getEntries()`. The
  executor-internal narrative path is unchanged — `enableNarrative()` alone
  adds no snapshot row, and `getNarrativeEntries()` returns exactly what it
  returned before.
### Fixed
- **A recorder that rides two channels was listed TWICE in
  `getSnapshot().recorders`** — `onError`/`onPause`/`onResume` are declared
  on BOTH the scope and flow recorder interfaces, so
  `attachCombinedRecorder` legitimately registers such a recorder on both
  inline lists (each channel calls the hook with its own payload variant —
  that is the design). The snapshot's serialization walked both lists with
  no shared `seen` set and emitted one row per registration, so
  `metrics()` — a pure data-flow recorder whose `onPause` counts pauses —
  appeared twice, breaking every consumer that indexes `snapshot.recorders`
  by id. Collection now emits ONE row per recorder id across both channels
  AND both delivery tiers (the deferred branch already deduped within
  itself; the dedupe is now shared). A recorder with no `toSnapshot` never
  claims an id, so it cannot shadow a same-id recorder that has one. The
  routing arrays in `CombinedRecorder.ts` are deliberately unchanged —
  they also drive the deferred tier's capture taps, and removing a shared
  hook name from one of them would silently blind deferred observers to
  that event (pinned by a new regression suite).

- **`commitValues: 'delta'` could silently lose a write** — when one stage wrote
  a whole key AND a path inside that same key (`scope.$setValue('a', […])` plus
  a nested `a.p` write), the delta-encoded commit could drop one of them, so the
  state you replay out of the commit log no longer matched the state the run
  actually produced. The default `'full'` mode was never affected. Why it
  happened: a commit's values are stored in a nested patch TREE keyed by path,
  so an entry for `a` and an entry for `a.p` share storage. In `'full'` mode
  every entry holds the FULL value at its path, drawn from one coherent tree, so
  a nested entry always agrees with its ancestor. Delta's encodings do not — an
  `append` stores only the array's new TAIL (whose indices are shifted relative
  to the whole array) and a `delete` stores an `undefined` marker — so whichever
  of the two entries was written second overwrote or corrupted the other, and
  the losing write was simply gone at replay. Depending on which side lost, a
  nested value vanished from the materialised state or an appended array grew
  phantom elements. Now any path that has a surviving ancestor or descendant in
  the same commit is recorded as a plain full-value `set` taken from one replay
  of that whole path family (the same value `'full'` mode commits), and the
  family's shallowest path is written last — the two entries can no longer
  destroy each other. Two neighbouring cases in the same encoder are fixed with
  it: an array carrying a named property (or a hole) no longer takes the
  `append` encoding, because replay rebuilds an append with a spread and a
  spread carries only indexed elements; and a nested `delete` whose parent is
  not a container (`b` is a string, the write is `b.1`) keeps the historical
  set-of-`undefined` flattening, because the `delete` verb's replay walks away
  from a non-container parent while the flattening coerces it — matching what
  the stage itself saw. Appends, deletes and merges on a key written alone —
  the shape delta mode exists for, and the overwhelming majority of commits —
  are byte-for-byte unchanged, tails included. Found by the delta/full replay
  equivalence property test (fast-check seed `-1006859621`); that counterexample
  is now pinned as a deterministic regression test, the property's generator was
  widened to cover deeper paths, array-index writes and nested deletes, and a
  300k-program differential fuzz over both modes now finds no divergence.

## [9.11.0] - 2026-07-09

### Added

- **`getSnapshot().runId`** — the run's id, surfaced read-only on the
  snapshot. `runId` already existed internally (generated per
  `run()`/`resume()`, stamped on every `TraversalContext`/recorder event) but
  `RuntimeSnapshot` never carried it, so a snapshot could not be joined
  against the event stream or an external correlation table without
  scraping a recorder. `FlowchartTraverser.getSnapshot()` is now the single
  authority: it stamps the same `runId` it already stamps on events onto
  the returned snapshot; `ExecutionRuntime.getSnapshot()` stays run-agnostic
  (`Omit<RuntimeSnapshot, 'runId'>`) — nested subflow runtimes deliberately
  carry no `runId` of their own. Stable within a run; regenerates across
  both `run()` and `resume()` (resume is logically a distinct run). Note:
  `runtimeStageId` collides across independent runs — `runId` is what
  disambiguates them for cross-run consumers.

## [9.10.1] - 2026-07-08

### Fixed

- **Cross-executor resume restarted the execution counter** — the documented
  resume pattern (`new FlowChartExecutor(chart)` + `resume(checkpoint)`)
  started `_executionCounter` at 0 and `_visitCounts` empty because
  `FlowchartCheckpoint` carried neither. Post-resume stages could RE-USE
  pre-pause `runtimeStageId`s (silently overwriting recorder entries keyed by
  them — observed as a resumed agent's `call-llm#18` clobbering its pre-pause
  entry), the resume cursor itself was rebuilt at `#0`, and `loopIteration` +
  the `maxIterations` budget restarted — violating the invariant
  "executionIndex … NOT reset on resume", which only held for same-executor
  resume. `FlowchartCheckpoint` now carries OPTIONAL `executionCount` +
  `visitCounts`; `buildPauseCheckpoint` stamps them (they ride the existing
  single structuredClone) and `resume()` seeds both BY MUTATION — the
  `{value}` box and the visit Map are shared by reference into every
  traverser including subflows — before the resume cursor's `runtimeStageId`
  is rebuilt. Backward compatible: old persisted checkpoints (Redis etc.)
  resume unchanged. New suite `resume-execution-counter-continuity`
  (cross-executor monotonicity, resume-cursor label, same-executor unchanged,
  back-compat, loop continuity).

## [9.10.0] - 2026-07-02

### Added

- **`writeProvenance: 'off' | 'reads-prefix'` (#P1)** — the fourth
  observability dial (readTracking/writeTracking/commitValues family, same
  propagation pattern incl. subflow inheritance). Under `'reads-prefix'`,
  every committed `TraceEntry` carries `readKeys`: the keys the stage had
  tracked-read BEFORE that write (temporal prefix — monotone, so delta-mode's
  one-entry-per-path keeps the union). Default `'off'` = byte-identical commit
  logs, zero cost. Independent of `readTracking` (key strings need no value
  retention). Snapshot discriminant: `getSnapshot().writeProvenance`.
- **`causalChain` `edgeAttribution: 'per-write'`** (+ `rootLinkKeys`) —
  consumes the provenance: a node reached via key `k` expands through only the
  reads that fed its write of `k` (incremental worklist for multi-key links),
  so a stage reading `a,b` and writing `x,y` no longer makes `x` appear to
  depend on `b`. HONEST FALLBACK: entries without `readKeys` expand that node
  at stage level — mixed or dial-off logs degrade to `'stage'` behavior
  exactly. Property-pinned: the refined slice is always a subset of the
  stage-level ceiling. `sliceForKey` DEFAULTS to `'per-write'` (safe by the
  fallback rule) and anchors `rootLinkKeys` to the sliced key.

- **`slice/` — variable-first backward slicing (the triage query layer)**, new
  tiny library at `src/lib/slice/` (DAG position `memory ← slice`), exported
  from `footprintjs/trace`. One contract for every triage surface — a human
  clicking a key in a UI, an LLM calling a `backtrack` tool, an offline autopsy
  agent — so their answers can never disagree:
  - `sliceForKey(commitLog, key, keysRead, opts?)` → `VariableSlice` — "why is
    this variable what it is?": anchors at the key's last writer
    (`findLastWriter`) and delegates the transitive walk to `causalChain`
    (controlDeps/weigh/maxDepth/maxNodes pass through). Honest absence is a
    first-class result: `missing: 'empty-log' | 'never-written'`.
  - `arrayProvenance(commitLog, key)` / `elementProvenance(commitLog, key, i)`
    — **append-fold provenance**: element-level birth records for array keys
    ("which stage produced `history[7]`?" — the fix for the agent mega-key
    problem). Zero new capture: folds the verbs the commit log already records.
    Every birth is honesty-labeled (`basis: 'append-verb'` — exact, delta mode;
    `'prefix-inference'` — full-mode growth heuristic; `'whole-value'` — reset).
    A property test pins value-equivalence with `commitValueAt`'s fold.
  - `KeysReadSource` strategy interface for where per-stage reads come from:
    `keysReadFromExecutionTree(tree)` (post-hoc, zero setup — reads live in the
    snapshot when `readTracking ≠ 'off'`), `keysReadFromMap(map)`, or any bare
    `KeysReadLookup` fn; the chosen strategy is recorded on
    `VariableSlice.keysReadKind`, plus `readsCoverage` telemetry so a
    reads-less provider (`readTracking: 'off'` signature) is machine-detectable
    — "reads were not recorded" is never confused with "no dependencies".
  - `sliceToJSON(slice)` + `formatSlice(slice)` — the ONLY safe
    serializations. `VariableSlice.root` is a shared-node DAG;
    `JSON.stringify` on it explodes combinatorially on diamonds. `sliceToJSON`
    is flat/id-referenced/linear (wire transfer, structured consumers);
    `formatSlice` is one bounded string for LLM triage tools, rendering the
    honesty envelope (missing reasons, reads-coverage warning, truncation).
  - Keys accept `StateKey = string | (string|number)[]` — nested paths are
    normalised internally; engine delimiters never appear in the public
    contract.
  - Examples: `examples/post-execution/variable-slice/` — zero-recorder key
    slice; loop-chart element provenance in both `commitValues` modes; and
    `03-llm-triage-tool.ts`, the `backtrack(variable, element?)` LLM tool
    contract on a plain chart (bounded strings, no LLM dependency).

## [9.9.0] - 2026-06-16

### Fixed

- **Subflow commit visibility — a looping subflow now retains EVERY iteration's
  commit log, not just the last** (additive, non-breaking). A deep subflow runs in
  an isolated runtime with its own commit log; `subflowResults` was keyed ONLY by the
  path-prefixed `subflowId`, so a loop re-entering the same subflow OVERWROTE the
  previous iteration — only the last survived. This silently broke per-loop causal
  backtracking inside any deep subflow (e.g. an agent's `call-llm` wrapped in
  `sf-llm-call`) and the explainable-ui drill-down (every loop iteration rendered the
  last iteration's internals).

### Added

- `subflowResults` is now **dual-keyed**: by subflow path (`subflowId` → the LAST
  iteration, back-compat — what `getSubtreeSnapshot` / `listSubflowPaths` resolve) AND
  by the per-execution mount `runtimeStageId` (e.g. `sf-pay#5` → that iteration). Look
  up a specific iteration as `subflowResults[node.runtimeStageId] ?? subflowResults[node.subflowId]`.
- `getSubtreeSnapshot()` now exposes **`history`** (the subflow's own commit log) — the
  first public door to a deep subflow's commits. `listSubflowPaths()` stays path-only
  (the per-execution `#` keys are filtered).

### Design

- The 9-agent review rejected MERGING nested commits into the run commit log as
  provably unsafe (bare-key cross-scope collision under the `runId===''` namespace); the
  run-level commit-log isolation invariant is untouched. The pause checkpoint stays lean
  (drops the per-iteration keys + strips per-subflow `history` — `resume()` never reads
  `subflowResults`). See `docs/design/subflow-commit-visibility.md`.

## [9.8.0] - 2026-06-11

### Added

- **RFC-003 D1 — `TraversalContext.parentRuntimeStageId`** (additive). Every
  stage execution's traversal context now carries the runtimeStageId of the
  execution step that preceded it — the runtime twin of `parentStageId`.
  Loop re-entries stay unambiguous (runtime ids differ per iteration even
  when stage ids repeat), and the chain CROSSES subflow boundaries: the
  first stage inside a subflow points at the MOUNT stage's runtimeStageId in
  the parent traverser (threaded via the new
  `SubflowTraverserFactory.parentMountRuntimeStageId` /
  `TraverserOptions.parentMountRuntimeStageId` plumbing). Absent — not
  `undefined`-valued — on the top-level chart's first stage. This is the
  engine groundwork for control-dependence tracking (D5's
  `controlDepRecorder`) and contextual bug localization.

- **RFC-003 D2 — untracked-read honesty flags
  (`CommitBundle.untrackedSources`)** (additive). A causal slice is built
  from TRACKED reads — but three read paths bypass tracking, and a consumer
  (human or LLM) debugging from the slice must be TOLD when that happened.
  The stage's commit bundle now carries
  `untrackedSources?: ReadonlyArray<'args' | 'env' | 'silent'>`:
  - `'args'` — the stage called `getArgs()`/`$getArgs()` with actual run
    input present (an empty-args read carries no information and is not
    flagged);
  - `'env'` — the stage called `getEnv()`/`$getEnv()` with a non-empty
    execution environment;
  - `'silent'` — the stage silently read (`getValueSilent`) a key it never
    TRACKED-read in the same stage. Silent reads SHADOWED by a tracked read
    of the same key (the TypedScope array-proxy pattern, `$batchArray`) are
    deliberately NOT flagged — their read→write edge is already captured,
    and flagging them would teach consumers to ignore the marker. This is
    the one refinement over the spec's literal "any `getValueSilent` use"
    wording, for exactly that reason.

  The field is ABSENT when a stage used none of these paths — charts that
  never touch them keep byte-identical commit logs (probe-verified), and
  the routine double-commit paths (fork children, subflow mounts) record
  the field exactly once because markers release with the staging state
  (#13b). The backtracker stamps `CausalNode.incompleteSources` from it and
  `formatCausalChain` renders
  `⚠ also consumed args/env — slice may be incomplete here`.
  Documented residual: values smuggled through JS closures stay
  undetectable. New type export: `UntrackedSource`
  (`footprintjs/trace` + `/advanced`). Cost: one lazily-allocated Set per
  stage that actually uses an untracked path; three boolean-ish checks
  otherwise.

- **RFC-003 D3 — control-dependence edges in the backtracker** (additive).
  `causalChain()` gains a `controlDeps?: ControlDepLookup` option: when
  expanding a node, the backtracker ALSO links its governing decider with a
  `kind: 'control'` edge, labeled by the decide() rule label when present.
  The decider node then expands normally through its own data reads, so
  chains like
  `status ← [control: Good credit] ClassifyRisk ← [data: creditScore] PullBureau`
  resolve end-to-end. New shapes:
  - `CausalEdge { parent, kind: 'data' | 'control', key?, weight }` — one
    edge per dependency LINK on the new `CausalNode.parentEdges` (a node
    reading two keys from the same writer gets one `parents[]` entry but
    two data edges). `weight` is 1.0 until the D4 `weigh` hook overrides
    it.
  - `ControlDependency` / `ControlDepLookup` — the lookup contract
    (`footprintjs/trace`); `controlDepRecorder()` (D5) is the built-in
    producer.

  `CausalNode.parents` is KEPT and unchanged for compatibility (control
  parents appear there too when the option is used); `formatCausalChain`
  renders control links as `← [control: <label>]` and the data rendering
  stays byte-identical to the pre-D3 output. Node/depth budgets apply to
  control expansion exactly like data expansion. Without the option,
  behavior is unchanged (existing backtrack suite green unmodified).

- **RFC-003 D4 — `weigh` hook + truncation visibility** (additive).
  - `causalChain()` gains `weigh?: EdgeWeigher` —
    `(child, parent, key, kind) => number | undefined` — called once per
    created edge; `undefined` → 1.0. The ENGINE never computes weights
    (zero new dependencies): semantics like embedding similarity or FDL
    influence are consumer-injected, the same plug-in pattern as
    `NarrativeFormatter`. Control edges weigh too (their `key` is the rule
    label). `formatCausalChain` renders weights as
    `← via systemPrompt (0.18)` — only when ≠ 1.0, so unweighted output is
    unchanged.
  - **Truncation visibility:** the root `CausalNode` gains
    `truncated?: { byDepth: boolean; byNodes: boolean }` — set only when a
    limit actually CUT the slice (`byDepth`: a node at the `maxDepth`
    horizon still had edges to expand; `byNodes`: the `maxNodes` budget
    dropped a discovered parent). Absent on complete slices.
    `formatCausalChain` appends
    `⚠ slice truncated (…) — older causes exist beyond this horizon`, and
    dev mode (`enableDevMode()`) warns — a consumer must never mistake a
    truncated slice for a complete one.

- **RFC-003 D5 — `controlDepRecorder()` (`footprintjs/trace`)** — the
  built-in producer for D3's `controlDeps` option. A `FlowRecorder` that
  records every `onDecision`/`onSelected` as
  `ControlDecisionRecord { deciderRuntimeStageId, chosen, evidence?, ruleLabel? }`
  (the label extracted from decide() evidence), builds the runtime ancestor
  chain from D1's `parentRuntimeStageId`, and maps every subsequently
  executed stage whose chain passes through the chosen branch to its
  governing decider. `lookup(runtimeStageId)` resolves the NEAREST decision
  (nested decisions compose — the backtracker expands the decider and asks
  again); `asLookup()` plugs straight into
  `causalChain(..., { controlDeps })`. Correlation is by parent-runtime-id
  + count, NOT stage name (subflow-mount events carry path-prefixed names;
  selectors emit a synthetic fork event sharing the selector's own
  runtimeStageId), and a branch that THROWS consumes its slot via
  `onError` so best-effort fan-out convergence stages are never
  misattributed. Convention-4 runId reset: each run (and each resume)
  starts clean — control chains do not survive a pause/resume boundary.
  Fixtures: decider, selector, nested subflow branches (single + double
  nesting), loop re-entry (per-iteration decisions stay distinct).
  Attach via `executor.attachFlowRecorder(ctrl)` or
  `attachCombinedRecorder(ctrl)`.

## [9.7.0] - 2026-06-11

### Added

- **#13c-B — `commitValues: 'full' | 'delta'`: delta/append commit verbs,
  the LOSSLESS commit-log encoding dial.** Completes the
  `readTracking`/`writeTracking` dial family — and unlike its siblings it
  is lossless in both modes: it changes the commit log's *encoding*, never
  its *information*. Opt in via
  `new FlowChartExecutor(chart, { commitValues: 'delta' })` or
  `executor.setCommitValues('delta')`. Design memo:
  [docs/design/13c-b-delta-commit-verb.md](docs/design/13c-b-delta-commit-verb.md).
  - **`append` verb** — when a stage's net change to a tracked array is
    "the old array plus a tail" (strict prefix, detected at the commit-time
    net-change diff), the bundle records ONLY the tail in `overwrite` under
    a `trace` entry with `verb: 'append'`. The growing-history commit log
    becomes linear instead of O(N²) retained: measured at N=200 the
    commit-log share (≈19.3MB) disappears; with all three dials the probe
    chart's retained heap collapses 59.7MB → **1.9MB**, and grows linearly
    (4.0MB @ N=500, 7.7MB @ N=1000) — bench §E Finding 7.
  - **`delete` verb** (absorbs backlog B8) — `deleteValue()` now commits a
    real `delete` trace entry under `'delta'`; replay REMOVES the key
    instead of leaving `key: undefined` behind. The path stays enumerated
    in `overwrite` so key-set consumers (e.g. lens highlights) still see
    the changed key. Under `'full'` the historical set-of-undefined
    flattening is preserved byte-for-byte.
  - **One trace entry per surviving path** (delta mode only) — `append` is
    not idempotent on replay, so delta bundles dedup the trace; entries are
    ordered by each path's last touch. Mixed set+merge interleavings commit
    the same value full-mode replay produces (property-tested replay
    equivalence at EVERY step, not just final state).
  - **Replay** — `applySmartMerge` gains `append` (concat) + `delete`
    (prototype-pollution-safe `nativeDelete`) arms; live state, time-travel
    `materialise()`, and the redacted mirror inherit both automatically.
    Redacted append tails record `'REDACTED'` in the log exactly like
    redacted sets; a redacted (non-array) tail degrades to the redacted
    value on replay — never spread char-by-char.
  - **`commitValueAt(commitLog, idx, key)`** in `footprintjs/trace` — the
    migration helper for the ONE semantic change: under `'delta'`,
    `bundle.overwrite[key]` is verb-qualified (an append bundle holds only
    the tail). `commitValueAt` reconstructs the full value at any commit
    index from either encoding, in O(key's commit span). Path-tier
    consumers (`findCommit`/`findLastWriter`/`causalChain`, narrative, lens
    shapes) are unaffected — pinned by tests over delta-mode logs.
  - **Snapshot discriminant** — `getSnapshot().commitValues: 'full' | 'delta'`
    reflects the active encoding for offline tooling.
  - **Default `'full'` is byte-identical** — verified with
    `scripts/byte-identity-probe.ts` against v9.6.0 (clean diff) and
    `bench:compare` (0 regressions; §E default row +0.0%).
  - **Honest wall-cost caveat** — append detection is NEW wall work: an
    O(|base array|) structural prefix compare per array-set path per commit
    (today's `deepEqual` fast-fails on length in O(1) for a grown array).
    On a hit the commit gets cheaper in both wall and heap (the full-array
    clone shrinks to a tail clone); on a miss it pays compare + full clone,
    bounded ≈2× one of today's clones. `'full'` pays zero — detection is
    mode-gated. The retained-heap quadratic is gone; a smaller *transient*
    wall quadratic (write-time clone + applyPatch whole-state clone)
    remains, tracked as the memo's §8.5 follow-up.
  - Plumbing mirrors the sibling dials exactly: executor option/setter →
    `ExecutionRuntime.useCommitValues` → root `StageContext` → inherited by
    `createNext`/`createChild` → pushed into subflow roots by
    `SubflowExecutor` → re-applied on the resume path.
  - Example: [examples/runtime-features/commit-values/01-delta.ts](examples/runtime-features/commit-values/01-delta.ts).

## [9.6.0] - 2026-06-11

### Review hardening (blocks 6–9 wiring gate)

- **Attach-surface capture default is `'clone'`** (was `'summary'` in the
  unreleased draft): `{ delivery: 'deferred' }` keeps existing recorder
  code working unchanged — same event shape as inline. `'summary'` is an
  explicit telemetry choice. (Review CRITICAL-2.)
- **Deferred listener errors respect channel registration**: a flow-only
  recorder never receives scope-channel listener errors — inline-tier
  parity. (Review CRITICAL-1; negative-control test added.)


### Added

- **RFC-001 deferred-observer delivery is WIRED (Blocks 6–9)** — the pure
  module shipped dark in 9.5.0 now powers a public delivery tier.
  - **Block 6 — tier router.** Every `attach*Recorder` accepts an options
    bag: `executor.attachScopeRecorder(rec, { delivery: 'deferred',
    capture?, maxQueue?, overflow?, sampleEvery?, flushBudgetMs? })` (same
    for `attachFlowRecorder` / `attachEmitRecorder` /
    `attachCombinedRecorder`; `CombinedRecorder` also supports the field
    form `{ id, delivery: 'deferred', ...hooks }`). Absent `delivery` is the
    literal pre-RFC inline path — byte-identical (verified with
    `scripts/byte-identity-probe.ts` against 9.5.0). ONE lazily-created
    `DeferredDispatcher` per executor (zero allocation when nobody opts in);
    attach stays idempotent by id ACROSS tiers — re-attaching an id with a
    different `delivery` swaps tiers cleanly, never double delivery. The
    module's warn seam is bound to a deduped `isDevMode()`-gated warner;
    listener failures route into the recorder `onError` channel.
  - **Block 7 — three dispatch sites.** Scope (`ScopeFacade._invokeHook`),
    flow (`FlowRecorderDispatcher`), and emit (`ScopeFacade.emitEvent`)
    channels route deferred listeners through `dispatcher.capture(...)` via
    synthetic capture taps riding the existing recorder lists; inline
    listeners keep the direct call. Both tiers invoke hooks through ONE
    shared `invokeRecorderHook` helper so the paths cannot drift. Capture
    runs strictly AFTER the redaction decision at each site
    (property-tested: no pre-redaction value in any envelope on any channel,
    under `'summary'`, `'clone'`, and `'ref'`).
  - **Block 8 — terminal flush.** The queue drains synchronously at run
    resolve, run reject, and pause — BEFORE `run()` returns / the rejection
    reaches the caller / the checkpoint becomes available. `flushSync`'s
    `remaining` is inspected: a pathological listener cascade that hits the
    round cap is counted (`observerStats.terminalStranded`) and dev-warned,
    never stranded silently. New `executor.drainObservers({ timeoutMs })`
    settles async listener continuations (serverless / shutdown pattern).
  - **Block 9 — `snapshot.observerStats`.** Additive optional field on
    `RuntimeSnapshot`: the A4 stats shape (`depth`, `drops`, `flushes`,
    `budgetExhausted`, `p95FlushMs`, `inlineDeliveries`, `inflight`,
    `perListener`) plus `terminalStranded`. Absent unless a deferred
    observer was attached (zero-cost discipline).
  - Public type exports from the main barrel: `AttachRecorderOptions`,
    `ObserverDelivery`, `ObserverStats`, `ObserverDrainResult`,
    `CapturePolicy`, `OverflowPolicy`, `DispatcherStats`, `ListenerStats`.
    The `observer-queue` module itself stays internal.
  - 43 new wiring tests (unit / functional / integration / property via
    fast-check / security / performance / load) + 4 runnable examples in
    `examples/runtime-features/deferred-observers/` (basic, backpressure,
    terminal flush, slow-listener bench) + `docs/guides/observers-deferred.md`.
  - Block 10 (agentfootprint one-consumer collapse) is downstream work and
    intentionally NOT part of this change.

## [9.5.0] - 2026-06-11

### Added

- **RFC-001 deferred-observer-delivery PURE MODULE (Blocks 1–5)** — internal,
  NOT yet public API (dark until Block 6 wires the engine).
  `src/lib/capture/envelope.ts`: `CaptureEnvelope` (seq-stamped,
  shallow-frozen, structured-clone-safe), `capture()` with policies
  `'summary' | 'clone' | 'ref'` (clone degrades to summary on unclonable
  payloads; `'ref'` dev-warns through an engine-free `CaptureHooks.warn`
  seam), and `summarizePayload()` — bounded (depth ≤ 3, ≤ 16 entries/level,
  ≤ 128 nodes, 80-char previews), reference-free, cycle/getter/proto-safe.
  `src/lib/observer-queue/`: `BoundedRing` (overflow policies
  `'drop-oldest' | 'sample' | 'block'`, every loss counted — drops leave
  visible seq gaps), `MergedQueue` (ONE totally-ordered queue across the
  scope/flow/emit channels, seq assigned at capture, default `maxQueue`
  10 000), `FlushDriver` (armed-once `queueMicrotask` batcher,
  `flushBudgetMs` default 2 / `Infinity`, snapshot semantics — listener
  cascades land next checkpoint), `DeferredDispatcher` (per-listener error
  isolation incl. async rejections, never-await flush, inflight set +
  `drain({timeoutMs})`, `'block'`→ synchronous inline delivery, A4 stats
  getter with per-listener time accounting). 84 new tests (unit /
  functional / property via fast-check / security / performance / load).
  Design doc: `docs/design/rfc-001-deferred-observers.md` (accepted with
  amendments A1–A4; engine wiring is Blocks 6–10).

### Fixed

- **Fn-bearing dynamic-next chains are now bounded by `maxIterations`** —
  loop edges (`loopTo` / dynamic next BY REFERENCE) were always counted by
  the `ContinuationResolver` per-node iteration counter and erred at
  `maxIterations` (default 1000), but FRESH function-bearing dynamic `next`
  nodes bypassed that counter (no back-edge, often no stable id): a stage
  that kept returning a fn-bearing dynamic next ran FOREVER on the flat
  trampoline (reproduced: 5000 hops with no budget while the `loopTo` twin
  erred at 1001; post-9.0.0 there is no stack overflow to brake it either —
  this was the known gap filed with the #15 trampoline release). A run-total
  dynamic-hop counter in `resolveTarget` now puts such chains under the SAME
  `maxIterations` budget (default 1000, tuned via `RunOptions.maxIterations`,
  propagates to subflows), erring in the loop guard's style:
  `Maximum dynamic-next continuations (N) exceeded at stage '…' (dynamic
  target '…'). Set maxIterations to increase the limit.` Legitimate chains
  are unaffected: hops under the budget run as before (byte-identical events/
  narrative), longer chains raise `maxIterations` exactly like long loops.
  **⚠ Behavior change:** a chart whose fn-bearing dynamic-next chain
  legitimately exceeds 1000 hops — which previously ran unbounded — now
  errs at the budget. Set `RunOptions.maxIterations` to the expected hop
  count to keep it running; the error message says exactly this.
  Docs: `RunOptions.maxIterations` JSDoc + `docs/guides/execution-model.md`.
  Regression suite: `test/lib/engine/traversal/dynamic-next-budget.test.ts`
  (runaway errs at default + tuned budgets, 500/2500-hop legitimate chains
  complete, reference-style dynamic next keeps the loop error, unit coverage
  of the resolver branch).

- **Nested-build description explosion** — `_appendSubflowDescription`
  embedded the mounted subflow's FULL builder-composed description inline on
  the `[Sub-Execution: …]` line AND re-listed its `Steps:` lines indented:
  two copies of the inner text per wrap, so each nested `build()` ~doubled
  the description. Exponential growth at BUILD time —
  `RangeError: Invalid string length` at ~22 nesting levels (224 MB of
  description at N=20), before anything ran. The mount line now inlines only
  the summary above `Steps:` (the `FlowChart: X` header) and keeps the
  single indented step re-list — 50 nesting levels build in <1 ms with a
  ~13 KB description, and the composed text reads as a clean indented tree
  (each inner step listed exactly once). Free-form (non-builder, no `Steps:`
  section) subflow descriptions are still inlined whole, unchanged. Spec
  ids/stageMap keys were never affected.
  Regression suite: `test/lib/builder/unit/nested-build-description.test.ts`.

## [9.4.0] - 2026-06-10

### Added

- **`writeTracking` retention dial for `StageSnapshot.stageWrites`** (backlog
  #13c-A) — the sibling of #14's `readTracking`; the two dials are
  independent. `new FlowChartExecutor(chart, { writeTracking })` or
  `executor.setWriteTracking(mode)` before `run()`:
  - `'full'` (default) — per-write `structuredClone` into the stage's write
    view. Byte-identical to the historical behavior (pinned by a
    negative-control clone counter).
  - `'summary'` — a cheap `WriteSummaryMarker`
    (`{ __writeSummary, type, size?, preview? }`, Map/Set report real entry
    counts) per write; zero tracking clones.
  - `'off'` — no `stageWrites` at all; zero tracking cost. The WRITE itself
    is untouched: shared state, the transaction buffer, the commit log,
    `onWrite` events, and narrative are byte-identical in every mode.
  Observable consequences: besides the snapshot, the commit observer payload
  (`ScopeRecorder.onCommit` mutations is a spread of the retained
  `_stageWrites`) carries the same markers under `'summary'` and arrives
  empty under `'off'`; per-op `onWrite` always delivers live values (delivery
  tier — RFC-001's concern). Redaction takes precedence over the dial:
  `'[REDACTED]'` under `'full'`/`'summary'` (a marker would leak
  size/preview), nothing retained under `'off'`. Plumbed exactly like
  readTracking: root context → `createNext`/`createChild` inheritance →
  subflow roots via `SubflowExecutor` → re-applied on the resume path.
  Measured on the §E retained-heap probe (N=200 growing-history loop): the
  `_stageWrites` share drops with `'summary'`/`'off'` while default rows are
  unchanged. New example: `examples/runtime-features/write-tracking/01-basic.ts`;
  25-test scenario suite `test/lib/memory/scenario/write-tracking.test.ts`.
  OUT OF SCOPE (by design, documented on the option): commit-log value
  payloads — deferred to **#13c-B's lossless delta/append verb** (one bundle-
  contract evolution, designed jointly with the RFC-001 §12 envelope);
  read tracking (shipped in #14); deferred observer delivery (RFC-001).

- **`src/lib/capture/` — shared value-capture/retention module** (#13c-A
  part 1; the module RFC-001's deferred-observer capture tier builds on).
  `RetentionPolicy = 'full' | 'summary' | 'off'` is the one family behind
  both dials (`ReadTrackingMode`/`WriteTrackingMode` are public aliases —
  zero type-level change for consumers); `summarizeReadValue` (extracted
  byte-identical from `StageContext`) and the new sibling
  `summarizeWriteValue` share ONE classification path. RFC-001 mapping
  documented in the module: RFC capture `'clone'` ≈ retention `'full'`,
  `'summary'` ≈ `'summary'`, `'ref'` is delivery-tier only (retention must
  never hold live references) — reserved, not implemented. New exports from
  the main + `advanced` barrels: `WriteTrackingMode`, `WriteSummaryMarker`,
  `RetentionPolicy` (+ `SUMMARY_PREVIEW_LENGTH` from the memory barrel;
  `READ_PREVIEW_LENGTH` kept as the shipped alias). All existing import
  paths unchanged.

## [9.3.0] - 2026-06-10

### Fixed

- **Long-run memory: per-stage staging state is RELEASED at commit end**
  (backlog #13b — the #18 root cause). The execution tree retains one
  `StageContext` per executed stage for the lifetime of the run, and each
  context pinned (a) its first-touch `stateView` — a reference to a DISTINCT
  full committed-state generation, because the engine clones + swaps the
  whole state per commit — and (b) its `TransactionBuffer` (two full-state
  clones), with zero release sites after commit. Retained heap grew O(N²)
  on loop charts: 849MB at 500 iterations on a growing-history chart
  (footprintjs-only reduction; the original #18 agent measurement OOMed a
  default Node heap at N=500). `StageContext.commit()` now nulls `buffer` +
  `stateView` at the end of BOTH paths (no-buffer fast path and buffer
  path). Both fields re-create lazily on a later touch, so every engine
  re-commit path (fork wrapper double-commit, subflow outputMapper
  double-commit, post-commit throttle write, pause commit) is observably
  identical — proven byte-for-byte across 9 scenarios by
  `scripts/byte-identity-probe.ts` and pinned by
  `test/lib/memory/scenario/commit-release.test.ts` (14 tests). Measured:
  N=200 retained heap 137.2MB → 59.7MB; N=500 849.1MB → 365.9MB; the
  execution tree now retains ZERO buffers and ZERO state generations. What
  remains is the audit surface by design — commit log + `stageReads`/
  `stageWrites` snapshot clones (read half gated by `readTracking` (#14);
  write half + per-commit clone wall cost tracked as #13c). New probe:
  `npm run bench:heap` (`bench/retained-heap.ts`). New example:
  `examples/runtime-features/long-loops/02-retained-memory.ts`. Lifetime
  contract documented in `docs/guides/execution-model.md`.

- **Examples: `read-tracking/01-basic.ts` imported `StageSnapshot` from the
  main barrel** — it is exported from `footprintjs/advanced`; the examples
  typecheck (`npm run test:examples`) was failing on a clean tree.

### Added

- **Machine-readable bench results + regression compare** (`fp-bench/1`).
  `bench:baseline` (sections A/B/C), `bench:depth` (D) and `bench:heap` (E)
  now ALSO write `bench/results/latest.json` — `{ schema: 'fp-bench/1',
  date, node, platform, commit, rows: [{ section, name, value, unit,
  detail }] }`, merged by section so `npm run bench` accumulates one
  complete file. `bench/BASELINE.md` stays the human doc, unchanged format
  (header now documents the JSON as the machine contract). New
  `npm run bench:compare` (`bench/compare.ts` + pure `bench/compareCore.ts`,
  12 unit tests) diffs two result files (default `bench/results/
  baseline.json` vs `latest.json`), prints per-row deltas, highlights
  regressions (▲ red ANSI, exit 1 above `--threshold`, default 25%) and
  improvements (▼ green). Regression gating is two-stage — relative
  threshold AND a per-unit absolute noise floor (0.5ms / 1MiB / 0.25 count)
  so µs-scale jitter can't cry wolf; zero-baseline rows (e.g. a flat depth
  slope regressing to 2.0/iter) flag on the absolute gate alone and are
  deliberately not silenceable by `--threshold`. The post-#13b run is
  committed as `bench/results/baseline.json` — the new reference;
  `latest.json` is gitignored (regenerated every run).

## [9.2.0] - 2026-06-10

### Added

- **`isFlowEvent()`: explicit `channel` discriminant on shared-method
  events** (backlog B3). Engine-dispatched `onError`/`onPause`/`onResume`
  events are now stamped `channel: 'flow'` (control-flow) or
  `channel: 'scope'` (data-flow) at construction, and `isFlowEvent()` checks
  that field FIRST — a positive signal that survives wrappers which
  add/strip fields. Unstamped events (consumer-fabricated tests, traces from
  older versions) fall back to the legacy pipelineId-absence heuristic, so
  existing behavior is preserved. The field is optional on the event types —
  purely additive.

- **`StageContext.createNext`: dev-mode warning when its arguments are
  silently ignored** (backlog B4). `createNext` is memoized — once `next`
  exists, later calls return it and ignore their arguments. With
  `enableDevMode()`, a call whose `stageName`/`stageId` differ from the
  existing next context now warns (production behavior unchanged). Normal
  traversal — linear chains, loops, resume — advances each context exactly
  once and never triggers it (pinned by test).

- **`decide()`/`select()`: dev-mode warning on unknown filter operators +
  vacuous-truth docs** (backlog B5). An operator outside `eq, ne, gt, gte,
  lt, lte, in, notIn` (e.g. a typo like `greaterThan`) already failed the
  condition silently; with `enableDevMode()` it now warns, naming the
  operator and key. The empty-filter rule (`when: {}` NEVER matches —
  anti-vacuous-truth, deliberately inverting Prisma/SQL `where: {}`) is now
  documented on `decide()`/`select()` JSDoc, `evaluateFilter`, and the
  decide README. Matching behavior is unchanged.

### Changed

- **Docs: `TransactionBuffer` semantics named honestly — staging buffer with
  read-your-writes + net-change commits, NOT rollback** (backlog B5). The
  class JSDoc, `memory/README.md`, `docs/guides/scope.md` and the top-level
  README no longer claim all-or-nothing/atomic commits: when a stage throws,
  the engine deliberately COMMITS everything staged so far before re-throwing
  (commit-on-error in `FlowchartTraverser`) so the audit trail records what
  the failing stage changed. The real guarantee is no mid-stage visibility
  (one batched commit per stage), not rollback.

## [9.1.0] - 2026-06-10

### Changed — truly lazy TransactionBuffer: the buffer is constructed on a stage's first WRITE, never on reads or commit (backlog #13)

- **Reads never construct the transaction buffer.** Before a stage's first
  write, `getValue`/`getValueDirect` serve from the stage's first-touch
  state view (see below) with the eager engine's exact live fallback —
  read-your-writes only matters once a staged write exists, and after the
  first write reads consult the buffer exactly as before. Previously the
  buffer (2× `structuredClone` of the ENTIRE shared state) was constructed
  on the stage's FIRST state access of any kind — including `commit()`,
  which runs after EVERY stage — so even a stage that never touched state
  paid the full-state clone freight.
- **`commit()` with no buffer is a zero-clone fast path** with the same
  observable outcome as an empty commit: the (empty) bundle is still
  recorded in the commit log — every executed stage remains a time-travel
  cursor stop — and the commit observer still fires; there is just no
  buffer construction and no `applyPatch` replay (which itself
  `structuredClone`d the whole state per commit).
- **Output is byte-identical.** Full snapshot JSON (commit log included)
  and narrative entries for a probe chart (reads-only stage + no-touch
  stage + same-value rewrite + writing stage) diff clean against the
  pre-#13 implementation. Net-change commit semantics are untouched:
  same-value writes and write-then-revert still produce empty bundles.
- **First-touch anchor (adversarial-review finding).** The buffer's diff
  base is the stage's FIRST-TOUCH state view — a zero-cost REFERENCE to
  committed state, safe because committed state is immutable-after-swap
  (`applyPatch` clones and swaps; nothing mutates it in place during
  traversal) — NOT the live state at first write. The difference is
  reachable under parallel forks: fork siblings are namespace-isolated for
  run keys, but ROOT-level keys (`setGlobal` from scope code; a subflow
  output mapping running inside a fork branch) can be committed by a
  sibling between a stage's first read and its first write, where a
  write-time base would record a phantom change or swallow a real one
  relative to the eager engine. Reads of view-present keys are repeatable;
  view-missing keys keep the eager engine's LIVE fallback. See
  `firstTouchState()` in `StageContext` and
  `docs/design/commit-change-semantics.md`.
- **Measured (Apple M2, 1MB shared state — `bench/BASELINE.md` §A):** first
  tracked read 4.97ms → **3µs**; per no-touch stage 10.19ms → **~40µs**;
  seed+read-only run 21.66ms → 14.61ms. Per-read VALUE clones (tracked-read
  freight, backlog #14) intentionally unchanged.
- Guarded by `test/lib/memory/scenario/lazy-buffer.test.ts` — clone-count
  assertions (instrumented `structuredClone`) fail against the eager-buffer
  implementation; semantics-parity assertions pass against both.

### Added — read-tracking policy: the per-tracked-read value clone is now opt-out (backlog #14)

- **`ReadTrackingMode = 'full' | 'summary' | 'off'`** gates the LAST
  per-operation full-value clone on the read path — the `structuredClone`
  of every tracked read's value into `StageSnapshot.stageReads`
  (`StageContext.getValue`). Set per executor:
  `new FlowChartExecutor(chart, { readTracking: 'off' })` or
  `executor.setReadTracking(mode)` before `run()`.
  - `'full'` (DEFAULT) — today's behavior, byte-identical. Snapshot
    consumers (lens, agentfootprint) see exactly the same `stageReads`
    payload as before; nothing changes unless you opt in.
  - `'off'` — no `stageReads` tracking at all: zero per-read cost, the
    field is absent from stage snapshots. For production agents, where
    reads dominate the loop.
  - `'summary'` — each read records a cheap `ReadSummaryMarker`
    (`{ __readSummary: true, type, size?, preview? }`) instead of the
    cloned value. Honest cost: `size` is a PROXY (string length / array
    length / object key count — `Object.keys` is O(key count), not free on
    huge objects but strictly cheaper than the clone), and `preview`
    (≤80 chars) exists only for primitives/strings — real byte sizes would
    require the O(value) serialization the mode exists to avoid.
- **Scope of the policy — snapshot payload ONLY.** `ScopeRecorder.onRead`
  events pass the live reference and never cloned (verified by
  measurement: 50 reads of a 1MB value with a recorder attached run in
  0.29ms under 'off', every event carrying the SAME reference), so
  narrative output and all recorder channels are byte-identical in every
  mode. `stageWrites`, the commit log, and read-your-writes are untouched.
- **Plumbing:** executor option / `setReadTracking` →
  `ExecutionRuntime.useReadTracking()` → root `StageContext`; descendants
  inherit via `createNext`/`createChild` (fork children included), and
  `SubflowExecutor` pushes the parent-mount context's mode into each
  isolated subflow runtime — nested charts inherit per mount hop.
- **Borrowed-reads contract documented (carried from #13's review):** reads
  at the `StageContext`/`ScopeFacade` tier return BORROWED references —
  into committed state before the stage's first write, into the buffer's
  working copy after. Do not mutate them; TypedScope consumers are safe
  (the proxy routes mutations through tracked writes). Documented on
  `ScopeFacade.getValue` and in `src/lib/memory/README.md`. Deliberately NO
  dev-mode deep-freeze guard: freezing a buffer-served read freezes the
  stage's own working copy (a later legitimate deep write into the same key
  would throw), and freezing a committed-state read mutates an object
  shared with every live-state consumer — no cheap guard is safe, so the
  contract is documentation-only.
- **Measured (Apple M2, `bench/BASELINE.md` §A):** 50 tracked reads of a
  1MB value — default 130.15ms (unchanged, within noise of 129.65ms);
  `'off'` **7µs**; `'summary'` 30.34ms (no clone; remaining cost is the
  key-count proxy on the bench's ~9.5k-key object).
- Guarded by `test/lib/memory/scenario/read-tracking.test.ts` — default
  parity (including a negative control asserting the clone DOES fire under
  'full'), zero-clone counters for 'off'/'summary', narrative byte-equality,
  subflow/fork plumbing, and policy-independent read-your-writes.

## [9.0.0]

### BREAKING — trampolined next/loop continuations: the depth ceiling on chains and loops is gone (backlog #15)

- **`executeNode` is now an iterative trampoline driver.** Every TAIL
  continuation — linear `next` hops, loop edges (`loopTo` / dynamic next),
  dynamic-subflow re-entry, and the branch dispatch of a decider with no
  continuation of its own — returns a flat continuation hop consumed by a
  driver loop (`current = next; continue`) instead of a recursive
  `await executeNode(...)`. The call stack AND the retained promise chain
  are now O(1) for chains and loops of any length. Per-node behavior is
  byte-identical: the step body is the old function body — phases, commit
  timing, recorder/narrative event order, break/pause/error semantics are
  unchanged (locked by a hardcoded pre/post narrative snapshot test).
- **What is now unbounded:** linear chain length and loop iterations.
  Measured on the depth-probe chart (`bench:depth`): guard/chain depth
  slopes 2.0/3.0 per iteration → **0.0**; the chart that hit the depth wall
  at iteration 249 now runs 10,000 iterations in ~0.5 s at the DEFAULT
  `maxDepth` with peak engine depth 1. A 5,000-stage linear chain completes
  at the default depth too.
- **What still bounds (honestly):**
  - **Real tree nesting.** `maxDepth` (default 500) now counts ONLY nested
    dispatch — fork children, selector branches, decider-with-continuation
    branch dispatch, recursive composition. Its error message says so.
  - **The loop-iteration limit** (default 1000 per node) — now actually
    REACHABLE (pre-trampoline the depth guard always fired first) and the
    binding constraint for loops, with its own actionable error.
  - **Memory.** Per-iteration state deltas, commit-log entries, and
    narrative entries still accumulate; appending to a tracked array each
    iteration retains O(N²) commit-log bytes (OOMs near ~2k iterations on
    an 8 GB machine). Keep tracked state bounded in long loops.
- **`RunOptions.maxIterations` (new).** The loop-iteration limit was always
  configurable on `ContinuationResolver` but never plumbed to the public
  API — the error's advice ("Set maxIterations to increase the limit") was
  previously unfollowable. Now: `run({ maxIterations })` /
  `resume(..., { maxIterations })`, validated >= 1, propagated to subflow
  traversers. Example: `examples/runtime-features/long-loops/`.
- **PauseSignal invoker semantics preserved across flat dispatch.** A
  decider whose branch is dispatched as a flat hop records an invoker stamp
  on the driver; if the continued chain pauses (even hundreds of loop
  iterations later), the signal is stamped with the innermost invoker on
  unwind — exactly what the recursive dispatch's catch did. Pause→resume
  inside a long loop (tested at iteration 600, past the old wall) works.
- **`StageContext.getSnapshot()` is now iterative.** The execution tree
  deepens by one level per executed stage along `next` chains; the old
  recursive serializer overflowed the JS stack on trampoline-scale runs
  (~2,000-iteration decider loops). Same output, explicit work stack.
- Internal engine API additions for the trampoline:
  `ContinuationResolver.resolveTarget(...)` (resolve a continuation without
  executing it; `resolve(...)` unchanged) and
  `DeciderHandler.prepareDispatch(...)` (run the decider stage + resolve the
  branch without executing it; `handleScopeBased(...)` unchanged).

## [8.3.0]

### Fixed — dynamic StageNode returns no longer mutate the shared built chart (backlog #7)

- **Traverser-local dynamic-patch overlay.** Phase 4 of `FlowchartTraverser`
  (dynamic StageNode-return handling) used to write the dynamic shape
  DIRECTLY onto the built chart's shared node objects —
  `isSubflowRoot`/`subflowId`/`subflowName`/`subflowMountOptions` (dynamic
  subflow), `children` + `nextNodeSelector` (dynamic fork), and `next`
  (restored after the visit — the only field that was). A chart built once
  is a shared artifact: the mutation leaked one run's dynamic graph into
  every later run of the same built chart (a fresh executor would re-execute
  stale dynamic children with the PREVIOUS run's closed-over args, or
  misclassify a stage as a subflow mount and skip its continuation) and
  raced concurrent executors sharing one chart. Phase 4 now writes patches
  into a per-traverser `dynamicPatches: Map<nodeId, DynamicNodePatch>`
  overlay that dies with the run — the built graph is never touched. Every
  engine read of the patched fields goes through effective-value accessors
  (`effChildren`/`effSelector`/`effIsSubflowRoot`/`effSubflowId`/`effNode`),
  and helper executors (`NodeResolver` loop-target DFS, `SubflowExecutor`,
  `ChildrenExecutor`) receive the effective node view instead of reading
  stale built fields. Dynamic `next` stays a local routed through
  `ContinuationResolver` — the save/restore dance on the shared node is
  gone. Fast path preserved: charts with no dynamic returns pay one
  `size === 0` check per read. Zero behavior change for any single run;
  `structureManager.updateDynamic*` observability events fire exactly as
  before.

## [8.2.0]

### Changed — snapshot/checkpoint boundary isolation (backlog #8)

- **Pause checkpoints are now deep-copied at creation.** `getCheckpoint()` /
  the `PausedResult.checkpoint` previously embedded the LIVE `SharedMemory`
  context as `sharedState` (the alias only detached at the next commit —
  post-pause, never), and `executionTree` nodes referenced live diagnostic
  bags. The docs said "store the checkpoint in Redis" while handing out live
  references. Now the whole checkpoint is detached via one `structuredClone`
  at pause time: mutating a checkpoint you hold cannot corrupt engine state,
  and a later same-executor resume cannot mutate a checkpoint you already
  persisted. Edge-case consequence of the (pre-existing) JSON-safe contract:
  a `pauseData` value that is not structured-cloneable (e.g. contains a
  function) now throws a **descriptive contract error** at pause time —
  naming the offending checkpoint field, with the raw `DataCloneError` as
  `error.cause` — instead of silently surviving in-process and breaking on
  real persistence.
- **Non-cloneable diagnostics never abort a pause (clone resilience).**
  `$debug`/`$error`/`$metric`/`$eval` accept ANY value at write time without
  cloning, so a function logged in any stage of a pausing run would have
  made the whole-checkpoint `structuredClone` reject with a naked
  `DataCloneError` — swallowing the human-in-the-loop pause. Now, on clone
  failure, the checkpoint's `executionTree` diagnostic bags
  (`logs`/`errors`/`metrics`/`evals`) are sanitized — non-cloneable values
  become `'[non-serializable: function]'`-style marker strings in the
  CHECKPOINT only (live engine diagnostics keep the raw value) — and the
  pause succeeds. If the clone still fails after sanitization, the
  violation is in consumer-owned data (realistically `pauseData`; functions
  in shared state, e.g. via the `initialContext` option, already reject at
  stage entry when the transaction buffer clones the context) and the
  descriptive contract error above is thrown. A naked `DataCloneError`
  never escapes the executor. Ingress points documented in
  [docs/guides/execution-model.md](docs/guides/execution-model.md).
- **`resume()` clones the checkpoint in.** `checkpoint.sharedState` and
  `checkpoint.subflowStates` are deep-copied before seeding engine runtimes
  (`mergeContextWins` copies only the top level), so the engine never holds
  a live reference into the caller's checkpoint object — caller mutations
  can't reach the resumed run, and engine writes can't bleed back.
- **Dev-mode mutation guard on `getSnapshot()`.** When `enableDevMode()` is
  on, `getSnapshot().sharedState` is a deep-frozen CLONE — consumer mutation
  throws a `TypeError` instead of silently corrupting engine state.
  Production behavior is unchanged: `sharedState` remains the zero-copy live
  view — treat it as read-only (documented in
  [docs/guides/execution-model.md](docs/guides/execution-model.md)).
  Clone-always in production is deferred pending the Phase-3 bench
  (~4 ms per `structuredClone` of a 1 MB state, Node 22/M-series).

## [8.1.0]

Minor — **re-entrancy guard + the honest execution-model doc** (backlog Phase 0,
items #1/#2 of the verified combined backlog, now in [BACKLOG.md](BACKLOG.md)).

### Changed (behavioral — read this)

- **`executor.run()` and `executor.resume()` now THROW on concurrent entry**
  on the same executor instance:
  `"FlowChartExecutor: run() called while another run()/resume() is in flight…"`.
  Previously this silently corrupted state — the two runs interleaved runIds,
  cross-contaminated recorder/narrative state, and `getCheckpoint()` returned
  whichever run paused last. The guard rejects the intruder **before any side
  effect** (the in-flight run is untouched; its recorders are not cleared) and
  releases on completion, throw, or pause. Sequential reuse and same-executor
  pause→resume are unchanged. **If you shared one executor across concurrent
  requests, you were corrupting traces — create one executor per run** (charts
  are immutable and safely shared). See
  [docs/guides/execution-model.md](docs/guides/execution-model.md).
- Entry-path hygiene (same "failed entry leaves no side effects" rule): input
  validation now runs **before** the `timeoutMs` timer is created (a rejected
  input can no longer leak a pending timer), and `resume()` no longer wipes
  `lastCheckpoint` before checkpoint validation (a rejected checkpoint no
  longer destroys the executor's existing checkpoint state).

### Added

- **[docs/guides/execution-model.md](docs/guides/execution-model.md)** — the
  supported envelope, stated honestly: executor-per-run lifecycle, the depth
  budget as it really is (caps the longest chain within ONE traverser; subflow
  mounts reset it; measured agent wall ≈ iteration 71), the current clone-cost
  table (incl. the truth that read-only stages pay buffer construction today),
  what checkpoints do/don't capture (recorder state: cross-executor resume
  starts empty, same-executor resume accumulates), and last-run-wins getters.
  Linked from the README.
- `test/lib/runner/reentrancy.test.ts` — 7 tests: run∥run, resume∥run,
  resume∥resume, sequential reuse, release-after-throw, release-after-pause,
  and intruder-clears-nothing.

### Fixed (docs/comments that contradicted the code)

- CLAUDE.md's pause/resume note now correctly scopes "recorders reset" to
  **cross-executor** resume (same-executor resume preserves + accumulates —
  `preserveRecorders`).
- `StageContext.getTransactionBuffer()`'s comment claimed "pay clone cost only
  if stage writes" — false (reads construct the buffer too). Now states the
  truth; truly-lazy-on-write is backlog Phase-3 #13.

## [8.0.0]

Major — zod becomes a truly optional peer. One breaking change: the zod-based
scope helpers move to a new opt-in `footprintjs/zod` entry.

### Changed (BREAKING)

- **The zod scope helpers are no longer re-exported from `footprintjs` or
  `footprintjs/advanced`.** They moved to the new **`footprintjs/zod`** entry.

  Why: re-exporting them from the core barrels forced **every** consumer to load
  zod eagerly — a plain `footprintjs` install would crash at load with
  `ERR_MODULE_NOT_FOUND: 'zod'` if zod wasn't installed, even when the consumer
  never used a zod schema. zod is declared as an **optional peer**, so the core
  must not import it. Now it doesn't: `footprintjs` and `footprintjs/advanced`
  load with zod completely absent.

  Migration — import from the subpath and add `zod` to your dependencies:
  ```ts
  // before
  import { defineScopeFromZod, defineScopeSchema } from 'footprintjs';
  import { createScopeProxyFromZod, isScopeSchema, ZodScopeResolver } from 'footprintjs/advanced';
  // after
  import {
    defineScopeFromZod, defineScopeSchema, createScopeProxyFromZod,
    isScopeSchema, ZodScopeResolver, type DefineScopeOptions,
  } from 'footprintjs/zod';
  ```

### Added

- **`footprintjs/zod`** subpath export — the opt-in home for `defineScopeFromZod`,
  `defineScopeSchema`, `isScopeSchema`, `createScopeProxyFromZod`,
  `ZodScopeResolver`, and the `DefineScopeOptions` type.

### Tests

- `api-conformance/zod-subpath` — locks the contract: the core barrels never
  export the zod helpers; the `footprintjs/zod` entry exports all of them.

## [7.1.0]

Minor — the commit log now records **net state changes**, not raw writes.

### Changed

- **`TransactionBuffer.commit()` emits a change-only payload.** A key is recorded
  in a `CommitBundle` only when its committed value actually **differs** from the
  base snapshot (structural deep-equal). No-op writes (`x = x`) and
  write-then-revert within a stage now produce an **empty** commit instead of a
  phantom entry.

  This makes the commit log a faithful record of what each stage *changed*, not
  merely what it *touched* — so time-travel consumers (e.g. a UI that highlights
  the stages responsible for a value) light up only the stages that genuinely
  changed state.

  **Observable behavior change (non-breaking to the type/API surface):** code that
  reads `executor.getSnapshot().commitLog` (or `footprintjs/trace` helpers like
  `findLastWriter` / `findCommit`) will see fewer entries for keys that were
  written without changing. This is the intended, more-correct semantics; see
  `docs/design/commit-change-semantics.md`.

### Added

- `deepEqual` internal helper (acyclic, JSON-shaped, allocation-free) used by the
  change-only diff.
- `docs/design/commit-change-semantics.md` — the design rationale and edge cases.

### Tests

- Property test (`change-only-commit`) — the invariant holds for randomized writes.
- Boundary/perf test (`change-only-perf`) — diff cost stays within budget at scale.

## [7.0.0]

Major — recorder model cleanup. One breaking change, removing long-deprecated API.

### Removed (BREAKING)

- **The three deprecated abstract recorder base classes are gone:**
  `KeyedRecorder<T>`, `SequenceRecorder<T>`, `BoundaryStateTracker<T>` (previously
  exported from `footprintjs/trace` and `footprintjs/advanced`). They were
  deprecated in v5 in favor of the composable stores and are now removed.
  **Composition via `KeyedStore` / `SequenceStore` / `BoundaryStateStore` is the
  only recorder-storage model** — there is no base class to extend.

  Migration — replace inheritance with a composed store field:
  ```ts
  // before (7.0.0 removed this)
  class TokenRecorder extends KeyedRecorder<TokenEntry> {
    onLLMCall(e) { this.store(e.runtimeStageId, e.usage); }
  }
  // after
  class TokenRecorder implements ScopeRecorder {
    readonly id = 'tokens';
    private readonly store = new KeyedStore<TokenEntry>();
    onLLMCall(e) { this.store.set(e.runtimeStageId, e.usage); }
    getForStep(id) { return this.store.get(id); }   // expose what you need
    clear() { this.store.clear(); }
  }
  ```

### Changed

- The built-in recorders (`MetricRecorder`, `QualityRecorder`, `InOutRecorder`,
  `CombinedNarrativeRecorder`) now **compose** a store instead of extending a base.
  Their public query methods (`getByKey` / `aggregate` / `accumulate` /
  `getEntries` / `getEntriesForStep` / `getEntryRanges` / `getEntriesUpTo` / …) are
  unchanged — only the (deprecated) base-class identity is gone. `instanceof
  KeyedRecorder` / `SequenceRecorder` checks no longer apply.

## [6.1.2]

Patch — packaging only. No API or behavior change.

### Changed

- **The ESM build now loads as true ESM.** `dist/esm` is marked `type:module`
  via a postbuild step, so Node, Deno, and Bun load it as real ECMAScript
  Modules instead of the syntax-detection fallback (every relative import
  already carried a `.js` extension; the lone worker-thread `require()` is
  guarded). Bundler consumers are unaffected; CJS `require` consumers are
  unaffected.

### Added

- **Tree-shaking guard test + badges.** A CI smoke test bundles a minimal
  `import { flowChart }` and asserts the recorder / detach / trace layers are
  pruned, plus true-ESM load of the main barrel and every subpath. README gains
  minzipped-size and tree-shakeable badges.

## [6.1.1]

Patch — one real fix + a full documentation correction pass.

### Fixed

- **`chart.recorder()` no longer silently drops emit recorders.** The fluent
  `chart.recorder(rec).run()` sugar detected only the scope + flow channels, so a
  recorder implementing only `onEmit` got zero events with no error. It now routes
  through the executor's combined-attach logic (scope/flow/emit detected uniformly,
  deduped — no double-attach).

### Docs

- Audited + corrected every hand-written doc and JSDoc `@example` against the
  current code (recorder family especially: v5 `*Store` classes vs the deprecated
  bases, executor method names, builder arg forms, `resume()` semantics).

## [6.1.0]

Additive feature release — no breaking changes (`^6.0.0` consumers upgrade safely).

### Added

- **Parallel fan-out `failFast`**: opt-in `Promise.all` semantics on a fan-out
  node so a _required_ parallel branch that throws rejects the whole run, instead
  of the default `allSettled` best-effort silently swallowing it. Honored on root
  selectors, `addSelectorFunction`, `addListOfFunction`, and subflow branches.
- **Branch-sourced `loopTo`** on `DeciderList`: a loop can originate from a decider
  branch (e.g. `tool-calls → context`) rather than from the decider node.
- **Structure-only `convergeAt`** (`SubflowMountOptions`): redirect a branch's
  convergence edge to a different stage as a 2-parent merge (no engine change).
- **`onRunFailed` terminal run boundary**: a failed run emits a symmetric CLOSED
  boundary (error-as-boundary, not error-as-stage) so observers see a clean
  terminal state. `CombinedRecorder` detection fixed for run-only recorders.
- `test:coverage` script + v8 coverage reporting + README coverage badge.

### Fixed

- Pause/resume: a branch loop whose target is a SUBFLOW resolved the loop-ref
  stub as the continuation; resume now resolves it to the real target node.

## [6.0.0]

Major release. Two themes ship together:

**Theme A — Extractor removal (the v5 → v6 migration story):** the
build-time + runtime extractor pattern is removed entirely and replaced
by two phase-specific recorders that were already shipping under L7:
`StructureRecorder` (build phase) and the existing `FlowRecorder`
(runtime phase). No deprecation period. See `MIGRATION-6.md` for the
recipes.

**Theme B — Observer-architecture polish (3 follow-up proposals):** new
helpers (`splitStageId`, `walkSubflowSpec`) on `footprintjs/trace`; new
fields on `StructureSubflowMountedEvent` (`subflowSpec`, `subflowPath`);
uniform `onStageExecuted` for ALL stage kinds with a new `stageType`
discriminator on `FlowStageEvent`.

### Theme B — Observer-architecture polish

### Added

- **`StructureSubflowMountedEvent.subflowSpec`** — the mounted subflow's
  complete spec (reference-equal to `subflow.buildTimeStructure`), set on
  every EAGER mount, undefined on lazy mounts. Lets a parent-attached
  recorder walk the subflow's full inner structure without needing
  inner-builder attachment (proposal #001).
- **`StructureSubflowMountedEvent.subflowPath`** — local mount id within
  the parent (`'auth'` for top-level, composed `'auth/verify'` for nested
  observations). Matches runtime `traversalContext.subflowPath` semantics
  (proposal #001).
- **`walkSubflowSpec`** exported from `footprintjs/trace` — a generator
  that yields the structural shape of a subflow spec as a flat ordered
  stream (`subflow-start` markers, `stage`/`edge`/`loop`/`subflow` items,
  auto-recurse with composed paths). Replaces the consumer-side
  connected-component "tag inner stages" workaround (proposal #001).
- **`WalkerItem`, `WalkerOptions`** types exported from `footprintjs/trace`.
- **`splitStageId(prefixedStageId)`** exported from `footprintjs/trace` —
  decomposes a prefixed stage id (`'sf-tools/execute-tool-calls'`) into
  `{ localStageId, subflowPath }`. Mirrors `parseRuntimeStageId`'s
  decomposition and applies uniformly to `spec.id`, `CommitBundle.stageId`,
  any prefixed id without the `#N` suffix (proposal #002).
- **`StageType`** union exported from the engine narrative types:
  `'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`
  (proposal #003).
- **`FlowStageEvent.stageType`** — REQUIRED discriminator field on every
  `onStageExecuted` event. Lets consumers route by stage kind without a
  side-table lookup into the chart spec (proposal #003).
- **`StructureRecorder`** + 6 event payload types
  (`StructureDeciderCompleteEvent`, `StructureEdgeAddedEvent`,
  `StructureEdgeKind`, `StructureLoopEdgeAddedEvent`,
  `StructureStageAddedEvent`, `StructureSubflowMountedEvent`) now exported
  from the **main `footprintjs` barrel**, not only `footprintjs/advanced`.

### Changed (behavior)

- **`onStageExecuted` now fires for ALL stage kinds**, not just linear
  stages. Previously, decider / fork / selector / subflow-mount stages
  fired only their specialized event (`onDecision` / `onFork` /
  `onSelected` / `onSubflowEntry`) and the engine returned without firing
  `onStageExecuted`. As of this release, the engine fires
  `onStageExecuted` AFTER the specialized event for these stages — every
  stage that runs produces exactly one `onStageExecuted` event, carrying
  the new `stageType` discriminator (proposal #003).

  **Migration**: consumers that used `onStageExecuted` to track "did this
  stage run?" no longer need separate `onDecision`/`onFork`/`onSelected`
  handlers for the same purpose. Consumers that used `onStageExecuted` as
  a LINEAR-ONLY signal must filter: `if (event.stageType !== 'linear')
  return;`. See `MIGRATION-6.md` for the recipe.

### Changed (docs / JSDoc)

- `parseRuntimeStageId` JSDoc now warns explicitly about the LOCAL-vs-FULL
  naming collision between its returned `stageId` field and `spec.id` /
  `node.id` for subflow-nested stages. Points consumers at `splitStageId`
  for safe decomposition (proposal #002).
- `StructureStageAddedEvent.stageId` JSDoc clarifies that the field
  carries the builder's LOCAL form at event-fire time, but `spec.id` is a
  LIVE reference that may be rewritten to the FULL prefixed form when
  this builder is mounted as a subflow (proposal #002).
- `StructureSubflowMountedEvent` JSDoc updated to describe the new
  `subflowSpec` and `subflowPath` fields, including the reference-equality
  guarantee and the lazy-mount caveat (proposal #001).

### Engine internals

- `IControlFlowNarrative.onStageExecuted` signature gained a required
  `stageType: StageType` argument. Custom `NarrativeGenerator`
  implementations must update their method signature.
  `NullControlFlowNarrativeGenerator` and the built-in
  `NarrativeFlowRecorder` / `CombinedNarrativeRecorder` were updated.
- `CombinedNarrativeRecorder.onStageExecuted` and
  `NarrativeFlowRecorder.onStageExecuted` gate to `stageType === 'linear'`
  (or undefined for back-compat) — narrative output is byte-stable across
  the v6 transition because the specialized handlers
  (`onDecision`/`onFork`/`onSelected`/`onSubflowEntry`) keep emitting
  their narrative entries unchanged.

### Tests

- +9 unit tests for uniform `onStageExecuted` (per-kind fire-order +
  literal `stageType` assertions + pause/error negative cases).
- +3 unit tests for `CombinedNarrativeRecorder` byte-stability (no
  double-emission for decider / fork / subflow-mount stages).
- +5 wiring tests for `subflowSpec` reference equality at all 4 eager
  mount sites + `subflowSpec: undefined` on lazy mounts.
- +8 unit tests for `walkSubflowSpec` (subflow-start markers, recursion,
  composed paths, `{recurse: false}`).
- +5 unit tests for `splitStageId` round-trip parity with
  `parseRuntimeStageId`.

### Theme A — Extractor rip-out

### Breaking changes

- **Removed** all extractor types: `BuildTimeExtractor`,
  `BuildTimeNodeMetadata`, `TraversalExtractor`, `ChartExtractor`, and
  `ExtractorError`. These were the v5.x build-time + runtime extraction
  surfaces.
- **Removed** `FlowChartOptions.extractor` field. `FlowChartOptions` is no
  longer generic — the new shape is `{ structureRecorders?, description? }`.
- **Removed** the legacy 5-positional `flowChart()` signature
  (`(name, fn, id, buildTimeExtractor?, description?)`). The factory now
  accepts only `(name, fn, id, options?)`.
- **Removed** builder methods: `addBuildTimeExtractor()`,
  `addTraversalExtractor()`, `getBuildTimeExtractorErrors()`.
- **Removed** executor method `getExtractorErrors()`. Use
  `builder.getStructureBuildErrors()` (call on the BUILDER, before/after
  `.build()`).
- **Removed** `FlowChartExecutorOptions.enrichSnapshots` field — it was
  only consumed by the extractor system and is now dead code.
- **Removed** internal: `FlowChartBuilder` `_flush()`,
  `_drainCursorIfPending()`, `_invokeOnBuildAdHoc()`,
  `_drainPendingFlush()`, `_chartExtractor`, `_buildTimeExtractor` fields;
  engine `ExtractorRunner.ts` deleted; `FlowchartTraverser` extractor
  wiring (`extractorRunner`, `callExtractor`, `getStagePath`,
  `getExtractedResults`, `getExtractorErrors`) removed.

### Replacement

- **Build-phase observation**: `StructureRecorder` — 5 events
  (`onStageAdded`, `onEdgeAdded`, `onLoopEdgeAdded`, `onDeciderComplete`,
  `onSubflowMounted`). Register via the options bag
  (`flowChart('seed', fn, 'seed', { structureRecorders: [rec] })`) or the
  fluent chain (`.attachStructureRecorder(rec)`).
- **Runtime per-stage observation**: already-shipping `FlowRecorder` with
  hooks like `onStageExecuted`, `onDecision`, `onSubflowEntry`, `onError`.
  Attach via `executor.attachFlowRecorder(rec)`.

### Migration

See [`MIGRATION-6.md`](MIGRATION-6.md) for diff-by-diff recipes covering
the four most common v5.x → v6.0 patterns.

## [5.0.0]

Major release — **recorder-system rewrite** plus a load-bearing build-time
extractor bug fix. See `MIGRATION-5.md` for a step-by-step upgrade guide
covering every breaking change.

### Breaking changes

- **`Recorder` → `ScopeRecorder`.** The data-flow channel's recorder
  interface is renamed for naming symmetry with `FlowRecorder` and
  `EmitRecorder`. The shape is unchanged — every method, every event
  payload is byte-identical. Only the import name moves. Most
  consumers should be able to do a single find-and-replace.
- **`attachRecorder` → `attachScopeRecorder`.** Same motivation — the
  executor method that wires a `ScopeRecorder` now carries the channel
  name explicitly.
- **Abstract bases → concrete stores (composition pattern).**
  `SequenceRecorder<T>`, `KeyedRecorder<T>`, `BoundaryStateTracker<T>`
  remain available for back-compat but are deprecated. The new primitives
  are `SequenceStore<T>`, `KeyedStore<T>`, `BoundaryStateStore<T>` —
  plain storage primitives that consumers compose via a field instead
  of extending. The composed form aligns with the project's Convention 1
  ("one purpose per recorder") and removes the multi-inheritance
  workaround Bracket trackers needed.

### Added — new storage primitives

- **`SequenceStore<T>`** — 1:N ordered storage shelf. The composable
  replacement for extending `SequenceRecorder<T>`. Exposes `push`,
  `getAll`, `getEntryRanges` (O(1) per-step ranges for time-travel),
  and `aggregate` / `accumulate` / `getEntriesUpTo` for slider scrub.
- **`KeyedStore<T>`** — 1:1 Map storage shelf. Replaces extending
  `KeyedRecorder<T>`. Exposes `set`, `get`, `getAll`, `aggregate`,
  `accumulate`, `clear`.
- **`BoundaryStateStore<T>`** — bracket-scoped transient state shelf,
  algorithmically the DFS-bracket-stack pattern. Open / update / close
  via `start`, `update`, `stop`. Exposes `getActive(key)`, `hasActive`,
  `activeCount`. Dev-mode wires the same three leak-detection
  diagnostics the `BoundaryStateTracker` had.

### Added — `runId` on `TraversalContext`

Every event the engine fires now carries a `runId` on
`traversalContext`. Generated fresh per `executor.run()` and per
`executor.resume()`; shared across all events of one run; differs
across consecutive runs of the same executor. Recorders that
accumulate state across runs detect "new run" via
`event.traversalContext.runId !== this.lastRunId` and reset transient
bookkeeping. See `examples/runtime-features/run-id/` for the
canonical patterns.

### Added — `CommitRangeIndex`

A small helper that builds an O(log n) range index over a commit log
for fast "what commits happened between runtimeStageId X and Y"
lookups. Used by Lens for time-travel scrubbing and by any consumer
that needs interval queries over the commit log.

### Fixed — `BuildTimeExtractor` was silently skipped on 6 builder sites

`FlowChartBuilder.ts` had **six methods** that produced spec nodes
WITHOUT calling `_applyExtractorToNode` on them, while every other
spec-producing method did. The result: consumers passing a
`BuildTimeExtractor` saw their per-node translator skip an entire
category of nodes — most visibly, every `Conditional` branch mount
spec (the `.when()` / `.otherwise()` outputs) was un-extracted.

Fixed sites:

| # | Class | Method | Line (pre-fix) |
|---|---|---|---|
| 1 | `DeciderList` | `addSubFlowChartBranch` | 179 |
| 2 | `DeciderList` | `addLazySubFlowChartBranch` | 224 |
| 3 | `SelectorFnList` | `addSubFlowChartBranch` | 450 |
| 4 | `SelectorFnList` | `addLazySubFlowChartBranch` | 493 |
| 5 | `FlowChartBuilder` | `addLazySubFlowChart` | 1152 |
| 6 | `FlowChartBuilder` | `addLazySubFlowChartNext` | 1202 |

All six now call `_applyExtractorToNode` after spec construction.
Zero-risk for consumers without an extractor (helper is a no-op when
`_buildTimeExtractor` is undefined). Consumers with an extractor will
now see their per-node UI shape / metadata applied to branch mount
nodes too.

### Documentation

- New `MIGRATION-5.md` with step-by-step before/after diffs for every
  breaking change.
- New `docs/design/v5-recorder-redesign.md` — the design memo behind
  the storage-primitive refactor.
- New `docs/design/commit-range-index.md` — algorithmic background +
  perf notes.
- New `docs-site/src/content/docs/api/agent.mdx` (and the previous
  `recorders.mdx` is retired in favor of the per-primitive pages).
- README + every `lib/*/README.md` updated to use the new names.

## [4.17.2]

### Added — `BoundaryStateTracker<TState>` — third storage primitive on the recorder shelf

A new abstract base class for tracking **transient bracket-scoped state**. Sits alongside `SequenceRecorder<T>` (durable ordered) and `KeyedRecorder<T>` (durable 1:1) as the third storage primitive on the recorder shelf.

**What it answers:** "At any moment during the run, what is the LIVE transient state of every currently-active boundary?" — for example, the partial answer of an in-flight LLM stream, the args of a tool call mid-execution, the running state of an agent turn between `turn_start` and `turn_end`.

**Mental model:**

> Existing recorder *interfaces* (`Recorder` / `FlowRecorder` / `EmitRecorder` / `CombinedRecorder`) are **observers**. Storage primitives are **bookkeeping shelves**. A real recorder picks ONE observer interface AND ONE storage shelf via `extends + implements` — the same pattern that's already used by `BoundaryRecorder` (which extends `SequenceRecorder<DomainEvent>` AND implements `CombinedRecorder`).

**API:**

```ts
import { BoundaryStateTracker } from 'footprintjs/trace';

class LiveLLMTracker
  extends BoundaryStateTracker<LLMLiveState>     // STORAGE shelf
  implements EmitRecorder                         // OBSERVER interface
{
  readonly id = 'live-llm';
  onEmit(e) {
    if (e.name === 'llm.start') this.startBoundary(e.runtimeStageId, { partial: '', tokens: 0 });
    if (e.name === 'llm.token') this.updateBoundary(e.runtimeStageId, s => ({ partial: s.partial + e.payload.content, tokens: s.tokens + 1 }));
    if (e.name === 'llm.end')   this.stopBoundary(e.runtimeStageId);
  }

  // O(1) reads
  isInFlight(): boolean { return this.hasActive; }
  getPartial(rid: string): string { return this.getActive(rid)?.partial ?? ''; }
}
```

**Algorithmic framing:** the DFS bracket-sequence pattern — stack-frame state during a graph-traversal interval. Same shape used by Tarjan's SCC algorithm, tree decomposition, and push-down automata. The internal `active` Map is the open-brackets stack at any moment.

**Public surface:**

- `protected startBoundary(key, initial)` — open a boundary
- `protected updateBoundary(key, updater)` — evolve in-flight state
- `protected stopBoundary(key)` — close + return final state
- `getActive(key) → TState | undefined` — O(1) read
- `getAllActive() → ReadonlyMap<string, TState>` — type-only readonly snapshot
- `hasActive` getter, `activeCount` getter
- `clear()` — lifecycle reset (called by executors before each run)

**Dev-mode safety:** call `enableDevMode()` to enable three diagnostic warnings (zero overhead in production):

- `clear()` warns if it finds residual active boundaries (likely missed `stopBoundary` upstream — a memory leak). Lists the leaked keys so the wiring bug is findable.
- `updateBoundary` before `startBoundary` warns at the 1st, 10th, 100th occurrence per key (rate-limited so a stuck loop doesn't spam the console).
- `startBoundary` on an already-active key warns (likely a missed `stopBoundary` upstream).

**What it is NOT for:**

- Time-travel queries ("what was the state at past slider step N?") — transient state clears on stop. For time-travel, snapshot to a `SequenceRecorder<TState>`.
- Run-wide aggregates — use `SequenceRecorder.aggregate()` / `KeyedRecorder.aggregate()`.
- Stage-level concerns — use `Recorder.onStageStart` / `Recorder.onStageEnd`. This primitive operates at finer granularity (events emitted DURING a stage execution).

**Lifecycle contract — strict:** every `startBoundary(key, ...)` MUST be paired with a `stopBoundary(key)`. Failure to wire the stop side leaks memory. Dev-mode warnings catch this; the JSDoc loudly emphasizes the invariant.

**Tests:** 33 unit/scenario/integration/property/perf/security/ROI tests across 7 tiers.
**Example:** [examples/runtime-features/data-recorder/06-boundary-state-tracker.ts](examples/runtime-features/data-recorder/06-boundary-state-tracker.ts) — a complete `LiveLLMTracker` demonstrating mid-stream peeks at transient state.
**Doc-site:** [Recorder storage primitives](https://footprintjs.github.io/footPrint/guides/features/recorder-storage-primitives/) — when to pick which shelf.

**Public exports:** `BoundaryStateTracker` is re-exported from `'footprintjs/trace'` and `'footprintjs/advanced'` (same convention as `KeyedRecorder` / `SequenceRecorder`).

Pure addition. No breaking changes. Existing recorders unaffected.

## [4.17.1]

### Fixed

- **`test/lib/detach/examples-integration.test.ts` builds `dist/` on demand.** The detach examples-integration test runs each example via `npx tsx`, which resolves `import { ... } from 'footprintjs'` to the package's `dist/index.js`. CI runs `npm test` BEFORE `npm run build`, so `dist/` didn't exist yet during the test — every detach example exited with `Cannot find module .../dist/index.js` and the v4.17.0 publish workflow failed before `npm publish` could run. A `beforeAll` hook now builds dist/ if missing (no-op locally where dist is already current). v4.17.1 is functionally identical to v4.17.0 — just makes the publish go through.

## [4.17.0]

### Added

- **`footprintjs/detach` subpath — fire-and-forget child flowchart execution.** A new pluggable-driver primitive for scheduling child charts off the parent's hot path: telemetry exports, parallel evaluations, audit log shipping, cache warm-up. Two semantics × two surfaces × six drivers.

  - **Semantics:** `detachAndJoinLater(driver, child, input)` returns a `DetachHandle` (poll `.status` sync, `wait()` for Promise). `detachAndForget(driver, child, input)` discards the handle for pure fire-and-forget.
  - **Surfaces:** scope methods `scope.$detachAndJoinLater(...)` / `scope.$detachAndForget(...)` (refIds tagged with the calling stage's `runtimeStageId` for diagnostic correlation), and bare-executor methods `executor.detachAndJoinLater(...)` / `executor.detachAndForget(...)` (refIds tagged `__executor__:detach:N`).
  - **Builder-native composition:** `addDetachAndForget(id, child, options)` and `addDetachAndJoinLater(id, child, options)` add detach as a labeled chart stage so it shows up in narrative + visualizations. Pure sugar over `addFunction` — zero engine changes.
  - **Six built-in drivers:**
    - `microtaskBatchDriver` — coalesces N detaches into one `queueMicrotask` flush. Cross-runtime (browser / Node / edge). Default for in-process detach.
    - `immediateDriver` — sync execution inside `schedule()`. Test fixture + tiny-payload aid.
    - `setImmediateDriver` — Node-only. `setImmediate`-based deferral. Yields to I/O before running.
    - `setTimeoutDriver` — cross-runtime. Configurable delay via `createSetTimeoutDriver({ delayMs })`.
    - `sendBeaconDriver` — browser-only. Survives page-unload via `navigator.sendBeacon`. Required `url` factory option.
    - `workerThreadDriver` — Node Worker Threads / browser Web Workers. CPU-isolated execution.
  - Each driver advertises `capabilities: { browserSafe?, nodeSafe?, edgeSafe?, survivesUnload?, cpuIsolated? }` so consumers can pick by environment. Drivers are passed explicitly as the first argument; no library-default keeps the engine free of driver imports.
  - **Custom drivers:** consumers implement the `DetachDriver` interface or use the `createXxxDriver(runChild)` factories with a custom `ChildRunner`.
  - **Handle is NOT Promise-shaped.** No `.then()` — defeats fire-and-forget. Status is a sync property; `wait()` returns a CACHED Promise on every call.
  - **`flushAllDetached(opts?)` — graceful shutdown helper.** Drains every in-flight handle to terminal across the process. Returns `{ done, failed, pending }`. Useful for SIGTERM handlers and test cleanup.
  - **8 runnable examples** under `examples/runtime-features/detach/` covering telemetry, fan-out, bare-executor, immediate driver, error handling, status polling, graceful shutdown, builder-native composition. Each example has a `.md` companion + regression guards. All examples run automatically as integration tests.
  - **159 detach tests** following the 7-pattern matrix (Unit / Boundary / Scenario / Property / Security / Performance / ROI) with 7-panel reviews per task.

  See [docs/guides/patterns/detach](https://footprintjs.github.io/footPrint/guides/patterns/detach/) for the full pattern guide.

### Fixed

- **`tsconfig.json` lib references corrected.** `target` upgraded `ES2018 → ES2022`; `lib` set to `["ES2022", "DOM"]`. Resolves long-standing build errors for `console`, `setTimeout`, `AbortSignal`, `structuredClone`, `Object.fromEntries`, `Promise.allSettled`, `queueMicrotask`, `Map`, etc. The library has used these globals for a while; the lib references just hadn't been updated to match. Build is now error-free.

- **Zod v3 schema conversion in `contract/schema.ts`.** The Zod-internals converter only handled v4-shape (`def.type: 'string'`) but the project's installed Zod is v3.x (which uses `_def.typeName: 'ZodString'`). Added a `normalizeV3Def()` helper that maps v3 field names (`typeName`, `value` → `values`, `values` → `entries`, function-form `shape`/`defaultValue`) to the v4-shape the rest of the converter expects. Fixes 19 failing `zodToJsonSchema` tests.

- **Zod schema unwrapping in `scope/state/zod/utils/validateHelper.ts`.** The `unwrap()` helper followed `_def.type` as if it were always an inner-schema reference — true for v3 `ZodEffects` / `ZodPipeline` but **wrong** for `ZodArray` (where `_def.type` IS the element schema). `unwrap(z.array(z.string()))` was incorrectly returning `ZodString` instead of `ZodArray`, which broke array detection in `analyze()` and made `proxy.items.set([...])` fail validation. Now gates descent on a known-wrapper allowlist (`Optional`, `Default`, `Nullable`, `Readonly`, `Branded`, `Catch`, `Effects`, `Pipeline`, `Lazy`). Fixes 4 failing zod-scope tests.

## [4.16.0]

### Fixed

- **`FlowChart` type duplication eliminated.** Previously, two types named `FlowChart` existed side-by-side — one in `lib/engine/types.ts` (used by `ComposableRunner.toFlowChart()` return type, `FlowChartExecutor` constructor, `RunContext`) and one in `lib/builder/types.ts` (used by `addSubFlowChart` parameter and produced by `FlowChartBuilder.build()`). The two had different required fields (builder required `description` + `stageDescriptions`; engine didn't), which made the documented composition pattern `parentBuilder.addSubFlowChart(runner.toFlowChart())` fail TypeScript. `FlowChart` now has a **single definition** in `lib/builder/types.ts`; all engine-side consumers import from there. Downstream libraries (e.g., `agentfootprint` v2 compositions) can now type `runner.toFlowChart()` into `addSubFlowChart()` without casts.

- **Dead `enrichSnapshots` field removed from the `FlowChart` type.** The field was read by `FlowChartExecutor` (`fc.enrichSnapshots`) but never assigned anywhere on the chart itself — `flowChart().build()` produces a chart with no such field. `FlowChartExecutor` now reads `enrichSnapshots` solely from constructor options / `run({ enrichSnapshots })`, which was already the working path.

- **Dead UI dependencies removed from `package.json`.** Previously, `footprintjs` declared 5 runtime `dependencies` (`highlight.js`, `react-markdown`, `react-resizable-panels`, `rehype-highlight`, `remark-gfm`) that were never imported anywhere in the library source or the documentation site (which uses Astro + Starlight with built-in Shiki highlighting). Removed — every consumer of `footprintjs` no longer pulls ~50 MB of unused React + markdown parsing libraries transitively.

### Added

- **`TopologyRecorder` — sibling-to-sibling `next` edges.** When subflows are mounted sequentially via `.addSubFlowChartNext(A).addSubFlowChartNext(B)`, the topology graph now emits an `A → B` edge with `kind: 'next'`. Previously, the recorder only emitted parent→child edges, leaving the sequential transition between siblings invisible. Consumers rendering execution topology (agentfootprint-lens pipeline view, etc.) now see the real `A → B → C` flow without reconstructing sibling ordering themselves. Purely additive — no existing edges removed.

- **`InOutRecorder` — chart in/out stream with mapper payloads.** New `SequenceRecorder` in `footprintjs/trace` that captures every chart execution (top-level `run()` AND every subflow) as an `entry`/`exit` boundary pair. Each entry carries the `inputMapper` payload (subflow) or run input (root); each exit carries the `outputMapper` payload (subflow) or chart output (root). Combined with `TopologyRecorder` (composition shape), this gives downstream layers (Lens, agentfootprint StepGraph) the universal "step" primitive — `runtimeStageId` binds shape to data. Path-aware via `subflowPath` decomposition (`['__root__']` → `['__root__', 'sf-x']` → ...). Exposed as `inOutRecorder()` factory + `InOutRecorder` class + `ROOT_SUBFLOW_ID` constant.

- **`FlowRecorder.onRunStart` / `onRunEnd` events.** Fire ONCE per top-level `executor.run()`, carrying `event.payload` (run input on start, chart output on end). Distinct from `onSubflowEntry`/`onSubflowExit` (which fire per subflow boundary). Available on `IControlFlowNarrative` and `FlowRecorderDispatcher`. Enables `InOutRecorder` to bracket the root run as `__root__#0` with `isRoot: true` and `depth: 0`.

- **Cross-executor `resume()`.** A fresh `FlowChartExecutor` (no prior `run()` on the instance) can now `resume(checkpoint, input)` from a serialized checkpoint — Redis / Postgres / S3 round-trip pattern. Previously the resume path implicitly required same-executor continuity and silently discarded `checkpoint.sharedState`, so resume handlers came back to an empty scope. The executor now branches on a `_hasRunBefore` flag: same-executor reuses the runtime; fresh-executor seeds a new runtime from the checkpoint. Same-executor behavior is preserved (execution tree + recorders + narrative still accumulate across pause/resume). Example: [examples/runtime-features/pause-resume/07-cross-executor.ts](examples/runtime-features/pause-resume/07-cross-executor.ts).

- **Subflow scope survival across pauses.** A pause inside a subflow (e.g. `Sequence(Agent-that-pauses)`) used to lose the subflow's isolated `SharedMemory` — it was GC'd as the stack unwound, before the checkpoint was built. On resume, the inner runtime came back empty and resume handlers reading pre-pause subflow scope (e.g. an Agent's `scope.history`, `scope.pausedToolCallId`) crashed with `undefined`. Fix is three-part: (1) `PauseSignal.captureSubflowScope(id, state)` — `SubflowExecutor` snapshots inner shared memory innermost-first on the bubble-up path; (2) new required `FlowchartCheckpoint.subflowStates: Record<subflowId, scope>` field — JSON-safe, always present (empty `{}` for root pauses); (3) `HandlerDeps.subflowStatesForResume` propagates through `FlowchartTraverser` → `SubflowExecutor`, which re-seeds nested runtimes from the map and skips the inputMapper to preserve pre-pause state.

### Fixed — Pause/Resume

- **Subflow-root description propagation.** `SubflowExecutor` was passing the parent mount node's `description` to `FlowSubflowEvent.description`, which is virtually always `undefined`. Downstream consumers (agentfootprint, Lens) couldn't distinguish Agent subflows from LLMCall subflows by reading taxonomy markers (`'Agent: ReAct loop'` / `'LLMCall: one-shot'`) on the subflow root. Fix: `SubflowExecutor` now reads `deps.subflows[subflowId].root.description` first, falling back to `node.description`.

### Changed — BREAKING

- **`narrative()` factory no longer decorates the recorder with `.lines()` / `.structured()` methods.** These were convenience aliases for `.getNarrative()` / `.getEntries()` on `CombinedNarrativeRecorder`. Callers now invoke those methods directly.

  Migration:
  ```typescript
  // Before
  const rec = narrative();
  const lines = rec.lines();
  const entries = rec.structured();

  // After
  const rec = narrative();
  const lines = rec.getNarrative();
  const entries = rec.getEntries();
  ```

- **`BoundaryRecorder` renamed to `InOutRecorder`.** The recorder shipped briefly under the `BoundaryRecorder` name; rename clarifies what it captures (chart in/out boundaries with payloads). No consumers in the wild — this is a same-cycle rename.

- **`FlowchartCheckpoint.subflowStates` is now required (was optional).** Always present — empty `{}` for root-level pauses. Tightening removes the absent-field branch in resume code; consumers reading `checkpoint.subflowStates` no longer need optional-chaining. No consumers in the wild for this field — feature shipped this same release.

### Examples — Restructured

- **Examples folder consolidated into a canonical tree.** The legacy flat `examples/features/*` and `examples/flow-recorders/*` directories have been redistributed into a structured hierarchy: `building-blocks/`, `runtime-features/{streaming,pause-resume,break,redaction,data-recorder,flow-recorder,combined-recorder,emit}/`, `build-time-features/{contract,self-describing,decide-select}/`, `post-execution/{causal-chain,quality-trace,snapshot,narrative-query}/`, `errors/`, `getting-started/`, `integrations/`. Every file in `examples/` is now type-checked on every PR via `npm run test:examples`. The structure mirrors `examples/DESIGN.md`'s coverage matrix; gaps in the matrix have been filled (6 new examples covering `contract/03-mapper`, `self-describing/04-spec`, `decide-select/{02-function-rules,03-mixed-rules,04-select-parallel}`, and `narrative-query/{02-entries,03-flow-narrative}`). The `footprint-playground` symlink already points at this tree, so playground samples track the canonical examples one-to-one.

### Non-breaking overall behavior

- All composition patterns (sequential subflow chains, parallel fan-out with merge, agent ReAct loops) continue to execute identically.
- Same-executor `pause()`/`resume()` semantics preserved — execution tree, narrative, and recorders accumulate across cycles as before.
- `FlowChart` type change is an internal consolidation — the public `FlowChart` export from `'./lib/builder/index.js'` (and the top-level `footprintjs` entry) is unchanged. Only deep-import consumers from the non-public `'footprintjs/lib/engine/types'` path would observe a difference, and that import path is not part of the supported public surface.
- Dead UI deps removal is transparent to consumers (they were never imported) — only the install footprint shrinks.

## [4.15.0]

### Added

- **`TopologyRecorder`** — new primitive in `footprintjs/trace`. Reconstructs a live, queryable mini-flowchart of what your run actually traced, built from the three primitive recorder channels (Recorder / FlowRecorder / EmitRecorder). Fills the asymmetry between post-run consumers (walk `executor.getSnapshot()`) and streaming consumers (see only events).

- **Three node kinds — complete composition coverage:**
  - `'subflow'` — via `onSubflowEntry` (mounted subflow boundary)
  - `'fork-branch'` — via `onFork` (synthesized one per child)
  - `'decision-branch'` — via `onDecision` (synthesized for chosen target)
  When a fork/decision target is also a subflow, the subsequent `onSubflowEntry` nests as a child — layered shape preserves both "who branched" and "what the branch ran."

- **Query API:** `getTopology()` returns `{ nodes, edges, activeNodeId, rootId }`. Convenience: `getChildren(id)`, `getByKind(kind)`, `getSubflowNodes()`, `getParallelSiblings(id)`. Every edge carries `at: runtimeStageId` for time correlation.

- **Exports from `footprintjs/trace`:** `topologyRecorder()` factory + `TopologyRecorder` class + types `Topology` / `TopologyNode` / `TopologyEdge` / `TopologyIncomingKind` / `TopologyNodeKind` / `TopologyRecorderOptions`.

- **Re-entry disambiguation.** Same `subflowId` re-entered (e.g., loop body) gets `id#n` suffix — consumers correlate via base id.

- **16 pattern tests + 1 integration test** covering 5 canonical compositions × 2 variants (plain-stage / subflow target for fork + decision), pending-state scope guard, lifecycle, real executor integration.

- **Example:** [examples/flow-recorders/06-topology-recorder.ts](examples/flow-recorders/06-topology-recorder.ts).

### Why this matters

Downstream domain libraries (agentfootprint, future X) compose `TopologyRecorder` instead of re-implementing subflow-stack + fork-map + decision-tracker bookkeeping. One primitive, many consumers, same accurate shape. `agentfootprint`'s `agentTimeline()` is the canonical reference.

### Non-breaking

Purely additive release. No existing APIs changed.

## [4.14.0]

### Added

- **Redacted snapshot mirror.** `FlowChartExecutor.getSnapshot({ redact: true })` returns a scrubbed `sharedState` — keys listed in `RedactionPolicy.keys` / matched by `RedactionPolicy.patterns` are replaced with `'REDACTED'`. Default / `{ redact: false }` continues to return the raw working memory (required for pause/resume, scope reads).
- **How it works.** When a `RedactionPolicy` is configured, `ExecutionRuntime` maintains a **parallel `SharedMemory` mirror** populated during traversal via the already-computed redacted patches from each commit (same ones fed to the event log). No post-pass, no walk over the final state — collection happens during traversal, matching the library's core principle. Zero allocation when no policy is set.
- **Why this matters.** Until now, `snapshot.sharedState` retained raw values even for keys known to be redacted — a real leak when exporting traces externally (paste into a viewer, share with support). The commit log was already redacted at write-time; the snapshot is now the last piece. See [docs/internals/adr-002-redacted-mirror.md](docs/internals/adr-002-redacted-mirror.md) for design rationale.
- **`ExecutionRuntime.enableRedactedMirror()`** — opt-in method called automatically by `FlowChartExecutor` when a policy is set. Exposed for advanced consumers driving the runtime directly.
- **13 new tests** across 5 patterns (unit/boundary/scenario/property/security) covering keys, patterns, mirror lazy creation, commit-log consistency, and the raw-secret-never-leaks invariant.

### Known limitations

- **`policy.fields: { key: [fieldNames] }` not yet reflected in the redacted mirror.** Field-level redaction still scrubs recorder dispatch (`onWrite` event value) but does not propagate into `getSnapshot({ redact: true })`. Pinned by a regression test. Workarounds: split sensitive fields into their own top-level keys, scrub user-side before exporting, or wait for a follow-up that extends the mirror to honor `fields` policy.

## [4.13.0]

### Added

- **Emit channel — third observer stream.** `scope.$emit(name, payload)` + `EmitRecorder.onEmit(event)` alongside existing `Recorder` (data-flow) and `FlowRecorder` (control-flow). Pass-through semantics (see [ADR-001](docs/internals/adr-001-emit-channel-pass-through.md)): synchronous, in-call-order, zero-allocation when no recorder attached. Events auto-enriched with `stageName`, `runtimeStageId`, `subflowPath`, `pipelineId`, `timestamp`. Error-isolated dispatch — a throwing `onEmit` routes to other recorders' `onError` without stopping the loop.
- **`CombinedRecorder`** — unified observer covering all three channels (`Partial<Recorder> & Partial<FlowRecorder> & Partial<EmitRecorder>`). One object, one `attachCombinedRecorder()` call; the library routes to channels via runtime method-shape detection. Detection counts only OWN methods (prototype walkers ignored, preventing `Object.prototype` pollution).
- **`FlowChartExecutor.attachEmitRecorder()` / `detachEmitRecorder()` / `getEmitRecorders()`** — attach/detach convenience mirroring the existing recorder APIs. Emit recorders share the scope-recorder channel internally.
- **`NarrativeFormatter.renderEmit(ctx)`** hook — consumers customize how emit events render in the combined narrative. Returns `string` to use, `null` to skip, `undefined` to fall back to `[emit] name: payloadSummary` default.
- **`RedactionPolicy.emitPatterns: RegExp[]`** — matched event names have their payload replaced with `'[REDACTED]'` before dispatch (scrubbed at origin, never reaches recorders).
- **Legacy primitives now dispatch on the emit channel in addition to their existing snapshot side-bags:** `$debug` → `log.debug.${key}`, `$error` → `log.error.${key}`, `$metric` → `metric.${name}`, `$eval` → `eval.${name}`, `$log.messages` → `log.debug.messages`. Closes the long-standing gap where `$metric`/`$debug` calls landed in collectors no recorder observed. Backward-compatible — side-bags still populate for snapshot-based consumers.
- **`$break(reason?)`** with optional reason string surfaced on `FlowBreakEvent.reason`.
- **`SubflowMountOptions.propagateBreak: true`** — opt-in propagation of `$break` from inner subflow to parent. Default (false) preserves current behavior: inner `$break` stops only the subflow. `outputMapper` still runs before propagation; nested chains propagate through every hop that opted in; parallel/fan-out: breaks only when all fork children broke.
- **ADR-001** documenting pass-through choice for emit channel — seven-perspective review rationale preserved at `docs/internals/adr-001-emit-channel-pass-through.md`.
- **Examples**: `examples/runtime-features/emit/01-custom-events.ts` (emit basics + regression guard), `examples/runtime-features/break/04-subflow-propagate.ts`, `examples/runtime-features/combined-recorder/05-custom-renderer-subflow-inputs.ts`.

### Fixed

- **`CombinedNarrativeRecorder` subflow-input ordering.** Subflow-input lines now route through `renderer.renderOp` at flush time (same as other reads/writes), preserving narrative order and respecting custom renderers. Previously bypassed the formatter, appearing out of order with custom renderings.

## [4.12.2]

### Fixed

- **Post-decider/selector stages run after branch-level resume.** When a pausable branch inside a decider/selector paused, resume completed the branch but never continued to post-decider stages. Fixed via invoker context on `PauseSignal` — collected during traversal bubble-up (same pattern as `prependSubflow`), no tree walking.

### Added

- **`PauseSignal.setInvoker()`** — stamps invoker stage ID and continuation stage ID during DFS bubble-up. `DeciderHandler` and `SelectorHandler` catch-enrich-rethrow when a branch child pauses.
- **`FlowchartCheckpoint.invokerStageId`** and **`continuationStageId`** — optional fields carrying the invoker context. Absent for linear pauses (backward compatible).
- **5 pause/resume examples** — decider branch, selector branch, no-continuation edge case (in `runtime-features/pause-resume/`).

## [4.12.1]

### Added

- **`addPausableFunctionBranch()`** on `DeciderList` and `SelectorFnList` — pausable stages directly inside decider/selector branches. No engine changes needed; `StageRunner` already handles `isPausable` on any node.
- **15 integration examples** in `runtime-features/` and `post-execution/` — cross-coverage testing features × building blocks (streaming+subflow, streaming+loop, pause+decider, pause+subflow, break+subflow, metrics+subflow, metrics+loop, causal-chain×5).
- **`examples/DESIGN.md`** — coverage matrix, gap analysis, folder structure plan for integration test layer.

## [4.12.0]

### Added

- **`causalChain()`** — Backward program slicing (Weiser 1984, thin-slice variant) on the commit log. BFS walks read→write dependencies to build a causal DAG answering "what stages contributed data to this result?" Exported from `footprintjs/trace`.
- **Staged optimization** — `causalChain()` automatically selects linear scan (≤ 256 commits) or reverse-index binary search (> 256 commits). Like a query optimizer choosing between sequential scan and index scan — the caller never sees the strategy.
- **`flattenCausalDAG()`** — BFS-ordered flat list from a causal DAG. **`formatCausalChain()`** — human-readable indented output with `← via key` annotations.
- **`QualityRecorder`** — Per-step quality scoring via custom `QualityScoringFn`, extending `KeyedRecorder<QualityEntry>`. Tracks `keysRead`/`keysWritten` per step for backtracking. `getOverallScore()`, `getLowest()`, `getScoreUpTo()` for progressive views.
- **`qualityTrace()`** — Quality Stack Trace: decorates `causalChain()` with quality scores to find root cause of quality drops. **`formatQualityTrace()`** for human-readable output.
- **`algorithm.md`** — Full algorithm reference for backward causal chain with Weiser/Sridharan citations, complexity tables, staged optimization decision tree.
- **47 examples** across 5 categories (building-blocks, features, flow-recorders, errors, integrations). Playground symlinked to library examples as single source of truth.

### Changed

- **Playground reorganized** into 3 categories: Building Blocks (9), Features (24), Use Cases (6). Was 7 categories.
- **`qualityTrace()`** now uses `causalChain()` as foundation — returns DAG-aware frames instead of linear list.

## [4.11.1]

### Added

- **Home page Radix UI upgrade** — 4-tab narrative ("The Code" → "The Logs Problem" → "The Cost Problem" → "The Pattern") with token cost comparison. Radix Slider execution timeline with colored bars and stats. Radix Accordion quick start. Vite build pipeline for `docs-site/home-src/`.
- **Docs guide restructure** — guides split into three categories: Building Blocks (stages, decisions, subflows), Features (recorders, self-describing, redaction, pause/resume, streaming), Patterns (error handling, loops & retry). 5 new guide pages.
- **SEO on all 28 Starlight pages** — meta author, keywords, `article:author`, `article:publisher`, `og:image` with width/height/alt for LinkedIn card previews, `twitter:image`, JSON-LD `TechArticle` with `sameAs` linking GitHub + LinkedIn.

## [4.11.0]

### Added

- **`examples/` directory** — 31 type-checked examples inside the library (getting-started, building-blocks, features, flow-recorders, errors). Each imports from `footprintjs` — same as consumer code. CI Gate 5b type-checks them before every release.
- **`StageEvent`** exported from main entry — was missing, needed by custom recorder implementations.
- **`npm run test:examples`** — type-checks all examples against library source.
- **Docs import from `@examples/`** — Starlight docs pull code from type-checked examples via Vite alias. One source of truth.

### Changed

- **Release pipeline** — 9 gates (was 8). Gate 5b: examples type-check.
- **Home page** — rebuilt with correct footprintjs API in all code snippets. Added loan rejection backtracking story, MCP tool generation, 4 badges (CI, npm, downloads, Try with LLM). Fixed asset path slash, syntax highlighter crash.
- **Home page Docs link** → getting-started guide (was TypeDoc API reference).

## [4.10.1]

### Added

- **Interactive home page** — custom React-based landing page replaces Starlight splash at docs-site root. Features execution timeline with time-travel slider, syntax-highlighted code examples (proxy pattern + rules DSL), 4-step problem narrative, and navigation cards to API docs, Playground, Samples, GitHub, npm.
- **SEO metadata** — Open Graph tags, Twitter Card, JSON-LD structured data (`schema.org/SoftwareSourceCode`) with author attribution.
- **Dark/light theme** — full theme toggle with footprint logo branding (FOOTPRINT + yellow "js").

### Changed

- **Docs-site landing** — original Starlight splash page moved to `/overview/` in sidebar. Custom Astro page at `src/pages/index.astro` serves the new home page with pre-built React assets from `public/home/`.

## [4.10.0]

### Added

- **`RecorderOperation`** — const object + type union (`translate | accumulate | aggregate`) for declaring preferred UI operation on recorders. Exported from main entry.
- **`preferredOperation`** on `RecorderSnapshot` and `toSnapshot()` interface — hints UI about which operation to show prominently. MetricRecorder defaults to `aggregate`, DebugRecorder to `translate`.
- **`description`** on `toSnapshot()` — recorder type and pattern description (e.g., "Aggregator (KeyedRecorder) — per-step timing and I/O counts"). All built-in recorders provide it.
- **`StageRenderContext.loopIteration`** — loop iteration number for custom `NarrativeRenderer`. Narrative now says "Looped back to X (pass N)" instead of "Next, it moved on to X" for loop iterations.
- **Subflow narrative input step entries** — `onSubflowEntry` carries `mappedInput` from `inputMapper`/`inputKeys`. Each input key rendered as a step entry: "Input: amount = 129.99". `onSubflowExit` carries `outputState`.
- **`FlowSubflowEvent.mappedInput`** / **`FlowSubflowEvent.outputState`** — subflow I/O values on flow recorder events.
- **`SubflowRenderContext.mappedInput`** / **`SubflowRenderContext.outputState`** — for custom subflow renderers.
- **MetricRecorder `toSnapshot()`** now includes per-step Map (`steps` keyed by runtimeStageId) alongside aggregated totals. Supports time-travel UI.
- **`numericField` + `grandTotal`** in recorder snapshot data — tells UI which field to display and the pre-computed total (no heuristics).

### Changed

- **`toSnapshot()` interface** widened on both `Recorder` and `FlowRecorder` — now includes `description?` and `preferredOperation?`. No more `as` casts in FlowChartExecutor snapshot collection.

## [4.9.0]

### Added

- **`SequenceRecorder<T>`** — abstract base class for 1:N ordered sequence recorders with keyed index by `runtimeStageId`. Sibling to `KeyedRecorder<T>` (1:1). Provides `getEntries`, `getEntriesForStep`, `getEntriesUpTo`, `getEntryRanges` (O(1) range index maintained during emit), `aggregate`, `accumulate`, `forEachEntry`.
- **`CombinedNarrativeEntry.runtimeStageId`** — unique per-execution-step identifier on all 13 narrative entry types. Links entries to recorder Map entries for O(1) time-travel lookup.
- **`CombinedNarrativeEntry.direction`** — `'entry' | 'exit'` on subflow entries. Use for programmatic subflow boundary detection instead of text scanning.
- **`SequenceRecorder.getEntryRanges()`** — precomputed `Map<runtimeStageId, {firstIdx, endIdx}>` for O(1) slider sync. Same shape as `buildEntryRangeIndex()` in `footprint-explainable-ui`.
- Exported `SequenceRecorder` from `footprintjs/trace`.

### Changed

- **`CombinedNarrativeRecorder`** now extends `SequenceRecorder<CombinedNarrativeEntry>` — dual-index storage (flat array + Map) replaces single-array storage. All existing methods preserved.
- **`pendingOps` keyed by `runtimeStageId`** (was `stageName`) — fork-safe buffering for parallel branches with identically-named stages.
- **`runtimeStageId` counter assignment** moved from `executeStage` to `executeNode` — ensures scope events and flow events use the same value (traversalContext created after assignment).

## [4.8.0]

### Added

- **`aggregate()` / `accumulate()` / `filterByKeys()`** on `KeyedRecorder<T>` — three standard operations on auto-collected traversal data: reduce all (dashboards), progressive reduce (time-travel slider), subset by keys
- **MetricRecorder extends `KeyedRecorder<StepMetrics>`** — per-invocation metrics keyed by `runtimeStageId`. Time-travel compatible: `getByKey('call-llm#5')` returns per-step reads/writes/duration.
- **`StepMetrics` type exported** — per-invocation entry type
- **`runtimeStageId` in execution tree snapshot** — `StageContext.getSnapshot()` includes it on each node

### Changed

- **MetricRecorder `getMetrics()`** — now computes aggregates on the fly from per-step data (same return type, backward compatible)
- **MetricRecorder `clear()`** — overrides `KeyedRecorder.clear()` to also reset `stageStartTimes` and `currentRuntimeStageId`

## [4.7.0]

### Added

- **`footprintjs/trace` subpath** — execution tracing utilities under a clean import path
- **`KeyedRecorder<T>`** — abstract base class for Map-based recorders (`store`, `getByKey`, `getMap`, `values`, `clear`)
- **`findCommit` / `findCommits` / `findLastWriter`** — typed commitLog query utilities for backtracking (no `(b: any)` casts)
- 15 new tests (6 KeyedRecorder + 9 commitLogUtils)

### Changed

- CLAUDE.md + AGENTS.md — documented `footprintjs/trace` with use cases, return types, and examples

## [4.6.0]

### Added

- **`runtimeStageId`** — unique per-execution-step identifier (`[subflowPath/]stageId#executionIndex`). On every recorder event, commit log entry, and traversal context. Monotonic counter shared across subflow traversers.
- **`buildRuntimeStageId()` / `parseRuntimeStageId()`** — helper utilities
- **17 new tests** — runtimeStageId across linear, loop, decider, subflow, global uniqueness

### Changed

- **FlowChartExecutor** — execution counter stored on executor, reset on `run()`, preserved on `resume()`

## [4.5.0]

### Added

- **`runtimeStageId`** — unique per-execution-step identifier on every recorder event, commit log entry, and traversal context. Format: `[subflowPath/]stageId#executionIndex`. Monotonic counter shared across subflow traversers. Enables key-value recorder maps, quality trace backtracking, and distributed tracing correlation.
- **`buildRuntimeStageId()` / `parseRuntimeStageId()`** — helper utilities for constructing and decomposing runtime IDs
- **`stageId` on RecorderContext + CommitBundle** — stable stage identifier on every event and commit
- **17 new tests** — runtimeStageId verified across linear chain, loop, decider, subflow, commitLog, and global uniqueness patterns

### Changed

- **PauseEvent/ResumeEvent** — removed redundant `stageId` field (now inherited from RecorderContext)
- **`notifyPause()`** — stageId sourced from StageContext instead of parameter
- **FlowChartExecutor** — execution counter stored on executor, reset on `run()`, preserved on `resume()`

### Fixed

- **`.playwright-mcp/`** — gitignored, removed accidentally committed browser session artifacts

## [4.4.1]

### Added

- **Pausable root stage** — `flowChart('Name', pausableHandler, 'id')` now accepts `PausableHandler` as the root stage. Enables single-stage pausable subflows without post-build graph mutation.

## [4.4.0]

### Added

- **ArrayMergeMode** — `SubflowMountOptions.arrayMerge` controls how array values from `outputMapper` merge into parent scope. `ArrayMergeMode.Concat` (default, existing behavior) appends. `ArrayMergeMode.Replace` overwrites. Essential for Dynamic loops where subflows recompute full arrays each iteration.
- **CombinedNarrativeEntry.key** — exposes the scope key (`string`) on narrative step entries. Enables structured data extraction (e.g., grounding analysis) without matching on rendered text strings.

## [4.3.1]

### Documentation

- **Blog section** — starlight-blog plugin with card grid, header nav (Docs/Blog/Playground), reading time, RSS feed, gradient background.
- **Blog post:** "Pause/Resume: Human-in-the-Loop for Backend Pipelines" with playground link.
- **CLAUDE.md** — documented pause/resume API for AI coding agents.

## [4.3.0]

### Added

- **Pause/Resume — human-in-the-loop for backend pipelines.** Pausable stages stop execution and create a JSON-safe checkpoint. Resume hours later, any server, with the human's response.
  - `addPausableFunction(name, { execute, resume }, id)` — builder method for pausable stages
  - `executor.isPaused()` / `getCheckpoint()` / `resume(checkpoint, input)` — pause lifecycle
  - `PausableHandler<TScope, TInput>` type — `execute` returns data to pause, void to continue
  - `FlowchartCheckpoint` — JSON-serializable checkpoint (store in Redis, Postgres, localStorage)
  - `ExecutorResult = TraversalResult | PausedResult` — proper union return type (no `as any` casts)
  - `ResumeFn<TScope>` — dedicated type for resume functions on StageNode
- **Pause/resume events on both observer systems:**
  - `FlowRecorder.onPause` / `onResume` — control flow events for narrative
  - `Recorder.onPause` / `onResume` — scope events for MetricRecorder (`pauseCount`, `totalPauses`) and DebugRecorder (pause/resume entries, logged even in minimal mode)
- **`pause/` library** (`src/lib/pause/`) — PauseSignal, FlowchartCheckpoint, PausableHandler, type guards. Internal to engine — consumers never import PauseSignal directly.
- **Blog post:** "Pause/Resume: Human-in-the-Loop for Backend Pipelines" in docs site.

### Changed

- **`resume()` reuses ExecutionRuntime** — execution tree, narrative, and metrics are continuous across pause/resume. No merge or graft needed.
- **`preserveSnapshotRoot()`** — `getSnapshot()` always returns the full execution tree from the original root, even after resume changes the traversal starting point.
- **Checkpoint validation** — `resume()` validates `sharedState` (plain object), `pausedStageId` (non-empty string), `subflowPath` (string array) before processing. Protects against tampered checkpoints from external storage.
- **PauseSignal passthrough** — 5 catch sites (FlowchartTraverser, SubflowExecutor, DeciderHandler, SelectorHandler, ChildrenExecutor) detect PauseSignal and re-throw without error logging.

## [4.2.0]

### Added

- **`recorder/` library — CompositeRecorder** (`src/lib/recorder/`) — composition primitive for bundling multiple recorders under a single ID. Implements both `Recorder` and `FlowRecorder` interfaces. Domain libraries use this to export one-call observability presets. Typed child access via `get(Type)`, merged `toSnapshot()`, and `clear()` lifecycle.
- **`MetricRecorder` stageFilter option** — `new MetricRecorder({ stageFilter: (name) => ... })` records only matching stages. Multiple instances with different filters coexist via auto-increment IDs.
- **`MetricRecorderOptions` type exported** from `footprintjs/recorders` — along with `AggregatedMetrics` and `StageMetrics`.
- **`metrics()` factory accepts options** — `metrics({ stageFilter })` passes through to MetricRecorder.

### Changed

- **`attachRecorder` is idempotent by ID** — same ID replaces existing recorder (prevents double-counting). Different IDs coexist. Applied to both scope recorders (`attachRecorder`) and flow recorders (`attachFlowRecorder`).
- **Recorder default IDs use auto-increment** — `MetricRecorder` defaults to `metrics-1`, `metrics-2`, etc. `DebugRecorder` defaults to `debug-1`, `debug-2`, etc. Multiple instances with different configs coexist naturally. Framework uses well-known ID `'metrics'` for override pattern.
- **`outputMapper` array concat behavior documented** — JSDoc on `SubflowMountOptions.outputMapper` warns that arrays are concatenated, not replaced. Return only the delta for array keys.

### Documentation

- **`recorder/` README** — full recorder architecture: ID contract, 12 built-in recorders table, CompositeRecorder pattern, custom recorder patterns, domain preset pattern, 6 design principles.
- **JSDoc `@example` blocks** on `attachRecorder`, `MetricRecorder`, `DebugRecorder`, `outputMapper` — code examples appear in IDE hover and API docs.

## [4.1.0]

### Added

- **Pluggable NarrativeRenderer** — `CombinedNarrativeRecorder` accepts a `renderer` option with optional hooks (`renderStage`, `renderOp`, `renderDecision`, `renderSubflow`, etc.) for custom narrative output. Unimplemented methods fall back to the default English renderer. `renderOp` can return `null` to exclude an entry.
- **Decision entries nest under decider stage** — condition entries now render at `depth: 1` (indented under their parent decider stage) instead of as separate top-level entries.
- **`outputMapper` array concat behavior documented** — JSDoc on `SubflowMountOptions.outputMapper` and CLAUDE.md anti-patterns section now warn that `applyOutputMapping` concatenates arrays (`[...existing, ...value]`). Return only the delta (new items) for array keys to avoid duplication.
- **Array proxy silent reads eliminated** — TypedScope array property access no longer emits redundant read events for internal proxy operations, reducing narrative noise.

### Tests

- **Pluggable renderer** — unit tests for custom `renderStage`, `renderOp`, `renderDecision` hooks.
- **Decider-in-subflow scenario** — verifies decision events fire with correct `traversalContext` when decider is inside a subflow.
- **Array proxy silent reads** — 11 tests verifying `.push()`, `.length`, `.filter()` etc. don't emit extra read events.
- **onCommit wiring** — 11 tests verifying scope recorder `onCommit` fires correctly per stage.

## [4.0.5]

### Fixed

- **SubflowExecutor continues after nested subflows instead of silently skipping** (`engine/handlers/SubflowExecutor.ts`) — when a chart built with `addSubFlowChartNext` was itself mounted as a subflow, `executeSubflowInternal()` returned immediately after a nested subflow completed, silently dropping all subsequent stages. Two fixes: (1) detect nested subflow nodes (`isSubflowRoot && subflowId`) and continue with `node.next` after `executeSubflow()` returns — mirrors `FlowchartTraverser.executeNode()` behavior; (2) save/restore instance variables (`currentSubflowRoot`, `currentSubflowDeps`, `subflowResultsMap`) around nested `executeSubflow()` calls to prevent parent context clobbering.

### Tests

- **Nested subflow continuation — 12 tests across 5 tiers** (`test/lib/engine/scenario/nested-subflow-continuation.test.ts`) — unit: stage after inner subflow executes, output doesn't swallow continuation; boundary: inner subflow at end of chain, empty inner subflow; scenario: multiple chained inner subflows, 3-level nesting, I/O mapping through nested, narrative captures entry/exit; property: execution order matches topology regardless of depth, snapshot available at every level; security: inner error propagates without skipping cleanup, break isolation.

## [4.0.4]

### Fixed

- **`$batchArray` JSDoc corrected: shallow clone, atomicity on error, type limitations** (`reactive/types.ts`) — the previous JSDoc said "mutable copy" which implies deep copy; corrected to "mutable **shallow copy**" with an explicit note that object references inside the array are shared. Added: if `fn` throws, `setValue` is never called and state remains unchanged. Added: `key` is untyped (`string`) and `arr` is typed as `unknown[]` — both are known limitations of `ScopeMethods` not being parameterized by `T`.
- **`$batchArray` added to CLAUDE.md escape hatches example** (`CLAUDE.md`) — was absent from the `$-prefixed escape hatches` code block in the TypedScope API section.

### Tests

- **`$batchArray` — fn throws: state unchanged, no write committed** (`test/lib/reactive/unit/batchArray.test.ts`) — new boundary test verifying atomicity on error.
- **`$batchArray` — shallow clone: object mutation inside fn affects original** (`test/lib/reactive/unit/batchArray.test.ts`) — new boundary test documenting the shallow-clone contract.
- **`$batchArray` — 10k-element performance test asserts final array length** (`test/lib/reactive/unit/batchArray.test.ts`) — tightened assertion: was only checking write count; now also asserts `length === 10_002`.

## [4.0.3]

### Added

- **`TypedScope.$batchArray(key, fn)`** (`reactive/types.ts`, `reactive/createTypedScope.ts`) — new escape hatch for batch array mutations. Every `scope.items.push(x)` in a loop clones the full array and commits it, giving O(N×M) total cost. `$batchArray` clones once, applies all mutations inside `fn` on the plain clone, then commits once — O(M) total regardless of how many mutations `fn` applies.

  ```typescript
  // Before: 1000 clones × growing array = O(N²)
  for (let i = 0; i < 1000; i++) scope.items.push(i);

  // After: 1 clone + 1 commit = O(N)
  scope.$batchArray('items', (arr) => {
    for (let i = 0; i < 1000; i++) arr.push(i);
  });
  ```

  `fn` receives a plain mutable array (not a Proxy). Mutations inside `fn` are not tracked individually — only the final committed array appears in the narrative as a single write. If the key does not exist or is not an array, `fn` receives an empty array.

## [4.0.2]

### Removed

- **`ExecutionRuntime.getFullNarrative()`** (`runner/ExecutionRuntime.ts`) — dead method that post-processed the `StageContext` tree after traversal. Zero callers. Violates the "collect during traversal, never post-process" core principle. The `walkContextTree()` private helper is also removed. The `NarrativeEntry` interface (its return type) is removed from both `footprintjs/advanced` and `runner/index.ts` exports.
- **`CombinedNarrativeBuilder.ts`** (`engine/narrative/CombinedNarrativeBuilder.ts`) — was a re-export shim pointing to `narrativeTypes.ts`. `narrative/index.ts` already exported from `narrativeTypes.ts` directly; the file was redundant.

### Changed

- **`loopTo()` spec stub now has `type: 'loop'` and `isLoopReference: true`** (`builder/FlowChartBuilder.ts`) — the back-edge reference node emitted by `loopTo()` previously had `type: 'stage'`, making it indistinguishable from real executable stages in visualization consumers. It now carries `type: 'loop'` and `isLoopReference: true`.
- **`'loop'` added to node type unions** (`builder/types.ts`, `engine/types.ts`) — `SerializedPipelineStructure.type`, `FlowChartSpec.type`, `RuntimeStructureMetadata.type`, and `SerializedPipelineNode.type` all now include `'loop'`. `computeNodeType()` returns `'loop'` for nodes where `isLoopRef === true`.
- **`pendingOps` keying comment corrected** (`engine/narrative/CombinedNarrativeRecorder.ts`) — previous comment claimed "name uniqueness prevents collision"; actual invariant is the event ordering contract (scope events for stage N are flushed before stage N+1's scope events begin).

### Fixed

- **`prefixNodeTree` unconditionally prefixes `node.id`** (`engine/traversal/FlowchartTraverser.ts`) — had a `if (clone.id)` guard that was dead code since `id` is required on `StageNode`. Removed to match the builder's invariant.
- **`branchIds` no longer uses `?? c.name` fallback** (`engine/handlers/RuntimeStructureManager.ts`) — `stageNodeToStructure()` always sets `id: node.id` (no fallback), so the `?? c.name` in `updateDynamicChildren` was dead code. Removed.
- **`stageNameToId` removed from `CombinedNarrativeRecorder`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — `bufferOp` used `stageNameToId.get(stageName)` to look up a stageId, but scope events (`onRead`/`onWrite`) always fire before `onStageExecuted` (which populated the map). The lookup was always `undefined`. `bufferOp` and `flushOps` now key by `stageName` directly.
- **`isLoopReference` added to `FlowChartSpec`** (`builder/types.ts`) — was present on `SerializedPipelineStructure` but missing from `FlowChartSpec`, causing the field to be absent from the type model for FE transport consumers.
- **`getSubtreeSnapshot` dev-mode warning message corrected** (`runner/getSubtreeSnapshot.ts`) — the Strategy 2 fallback warning previously said "no ExtractorRunner is attached" as the only cause. Updated to mention both causes: missing ExtractorRunner or `enrichSnapshots` not enabled.
- **`enrichSnapshots` JSDoc expanded** (`runner/FlowChartExecutor.ts`) — was a one-liner; now accurately describes what it does, when to use it, and how it relates to the chart-level `enrichSnapshots(true)` method.
- **`isLoopRef` JSDoc cross-references `isLoopReference`** (`engine/graph/StageNode.ts`) — the runtime graph field (`isLoopRef`) and the serialization spec field (`isLoopReference`) use different names; a JSDoc comment now documents the intentional divergence.

## [4.0.1]

### Fixed

- **`prefixNodeTree` now prefixes `node.id`** (`engine/traversal/FlowchartTraverser.ts`) — subflow namespace isolation was prefixing `node.name` but not `node.id`, causing `id`-keyed stageMap lookups to miss prefixed entries. Both `name` and `id` are now prefixed, consistent with how `FlowChartBuilder` always sets them together.
- **`SerializedPipelineNode.id` is now required** (`engine/types.ts`) — was `id?: string` while the builder always sets it; aligned with `builder/types.ts` which already required it.
- **`ScopeFactory` exported from `engine/types` (4-param)** (`advanced.ts`) — was accidentally re-exporting the 3-param version from `memory/types`, missing the `executionEnv` parameter. Now exports the canonical 4-param version used by the traverser.
- **`CombinedNarrativeRecorder.pendingOps` keyed by `stageId`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — was keyed by stage name, which could collide when two stages shared a display name but had different IDs. Now keyed by the stable `stageId`.
- **`RuntimeStructureManager` update methods emit dev-mode warn when node missing** (`engine/handlers/RuntimeStructureManager.ts`) — `updateDynamicChildren`, `updateDynamicSubflow`, and `updateDynamicNext` silently no-oped when called with an unregistered node ID. They now emit a `console.warn` in dev mode, matching the project's silent-skip warning rule.
- **`specToStageNode` removes `id ?? name` fallback** (`builder/FlowChartBuilder.ts`) — now that `id` is required in both type definitions, the defensive `id: s.id ?? s.name` fallback was dead code hiding potential misconfiguration. Removed.
- **`FlowChartExecutorOptions` exported from public API** (`src/index.ts`) — was accessible only as an import from the internal runner path.
- **`CombinedNarrativeBuilder.ts` converted to re-export shim** (`engine/narrative/CombinedNarrativeBuilder.ts`) — types moved to `narrativeTypes.ts`; old file is now a thin re-export for any consumers that imported from the old path.

## [4.0.0]

### Removed

- **`NarrativeRecorder` class** (`scope/recorders/NarrativeRecorder.ts`) — superseded by `CombinedNarrativeRecorder` (via `executor.recorder(narrative())`). All associated types (`NarrativeDetail`, `NarrativeOperation`, `StageNarrativeData`, `NarrativeRecorderOptions`) are also removed. Migration: replace `executor.attachRecorder(new NarrativeRecorder())` with `executor.recorder(narrative())` from `footprintjs/recorders`.
- **`typedFlowChart()` function** (`builder/typedFlowChart.ts`) — use `flowChart<T>(name, fn, id)` instead, which is identical and auto-embeds the TypedScope factory. `createTypedScopeFactory` remains available in `footprintjs/advanced` for custom executor setups.
- **`StageContext.get()` method** (`memory/StageContext.ts`) — deprecated alias for `getValue()`. Use `ctx.getValue(path, key)` directly.
- **`StageContext.getFromRoot()` method** (`memory/StageContext.ts`) — deprecated alias for `getRoot()`. Use `ctx.getRoot(key)` directly.
- **`StageContext.getFromGlobalContext()` method** (`memory/StageContext.ts`) — deprecated alias for `getGlobal()`. Use `ctx.getGlobal(key)` directly.
- **`FlowChartExecutor` positional params 3–9** (`runner/FlowChartExecutor.ts`) — the 9-positional-parameter constructor form is removed. Pass an options object instead: `new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true, ... })`. The 2-param form `new FlowChartExecutor(chart, scopeFactory)` is retained.
- **`ControlFlowNarrativeGenerator`** (`engine/narrative/ControlFlowNarrativeGenerator.ts`) — dead code; never instantiated at runtime (replaced by `NarrativeFlowRecorder` + `FlowRecorderDispatcher` in v0.9.x). Removed along with its test file.
- **`FlowChartExecutor.getEnrichedResults()`** — duplicate alias for `getExtractedResults()`. Use `getExtractedResults()` directly.

### Changed

- **`SerializedPipelineStructure.id` and `FlowChartSpec.id` are now required** (`builder/types.ts`) — both fields were `id?: string` but every builder-produced node always set them. Making them required closes the gap between the type and the runtime guarantee.
- **stageMap keyed by `id` not `name`** (`builder/FlowChartBuilder.ts`) — the internal stage function map previously used the human-readable stage name as the key, causing collisions when two stages had the same display name but different IDs. The map now uses the stable `id`.
- **`HandlerDeps.ScopeFactory` renamed to `scopeFactory`** (`engine/handlers/types.ts`) — the field was PascalCase while all other `HandlerDeps` fields are camelCase. Renamed for consistency.
- **`computeNodeType` returns `'subflow'` for `isSubflowRoot` nodes** (`engine/handlers/RuntimeStructureManager.ts`) — subflow entry points were previously classified as `'stage'`. The `SerializedPipelineStructure.type` union now includes `'subflow'`.
- **`CombinedNarrativeRecorder.onSelected` emits `type: 'selector'`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — was incorrectly emitting `type: 'fork'`, making selective fan-out indistinguishable from full parallel fork. `CombinedNarrativeEntry.type` union now includes `'selector'`.
- **`NarrativeFlowRecorder.onStageExecuted` emits for every stage** (`engine/narrative/NarrativeFlowRecorder.ts`) — previously only emitted a sentence for the first stage and silently dropped all subsequent `onStageExecuted` calls. Now consistent with `CombinedNarrativeRecorder`.
- **`addSelectorFunction` tracks `id` in `_knownStageIds`** (`builder/FlowChartBuilder.ts`) — `loopTo()` can now target a selector stage by ID, matching the existing behavior of `addDeciderFunction`.
- **`buildNodeMap` depth guard applies at all call sites** (`engine/handlers/RuntimeStructureManager.ts`) — the `MAX_NODE_MAP_DEPTH` guard was only applied during `init()`; it now applies in `updateDynamicChildren`, `updateDynamicSubflow`, and `updateDynamicNext` as well.
- **`toMermaid()` exposed on `RunnableFlowChart`** (`runner/RunnableChart.ts`) — was only accessible on `FlowChartBuilder` (before `.build()` was called). Now callable on the built chart.

### Fixed

- **`extractScopedNarrative` no longer post-walks narrative text** (`runner/getSubtreeSnapshot.ts`) — previously scanned the full narrative array for `"entering"`/`"exiting"` string markers to reconstruct subflow scope. Now filters by `entry.subflowId` field which is set during traversal. Eliminates post-process text search.
- **`NodeResolver.findNodeById` uses pre-built O(1) map** (`engine/handlers/NodeResolver.ts`) — replaced a full DFS walk (called on every loop iteration) with a `Map<string, StageNode>` built at traversal start, reducing `loopTo` resolution from O(n×depth) to O(1).
- **`SelectorHandler.onError` now passes `traversalContext`** (`engine/handlers/SelectorHandler.ts`) — was the only `onError` call site missing the context argument, breaking recorder correlation for selector errors.
- **`FlowRecorderDispatcher` swallowed recorder errors now emit dev-mode `console.warn`** (`engine/narrative/FlowRecorderDispatcher.ts`) — silent swallow violated the project's own "silent skips must have dev-mode warning" rule.
- **`FlowRecorderDispatcher.getSentences()` no longer duck-types** (`engine/narrative/FlowRecorderDispatcher.ts`) — replaced `as unknown as Record<string, unknown>` cast with a typed `NarrativeFlowRecorder` lookup.
- **`addFunctionBranch` validates `fn` at build time** (`builder/FlowChartBuilder.ts`) — branches without a function now throw at `end()` rather than failing silently at runtime when the branch is chosen.
- **`RuntimeStructureManager` deep-clone wrapped in try/catch** (`engine/handlers/RuntimeStructureManager.ts`) — `JSON.parse(JSON.stringify(...))` threw unhandled `TypeError` for cyclic structures; now produces a clear error message.

## [3.1.0]

### Fixed
- **Concurrent FlowChartExecutor runs no longer race on shared FlowChart** (`engine/FlowchartTraverser.ts`) — `stageMap` and `subflows` were shared references from the compiled `FlowChart` object. Lazy-resolution writes (prefixed entries added during execution) mutated the shared dict, causing a race condition when two executors ran the same `FlowChart` concurrently (normal server-side behaviour). Both are now shallow-copied in the `FlowchartTraverser` constructor so per-run mutations stay scoped to the individual traverser. Additionally, the old `node.subflowResolver = undefined` write-back to the shared `StageNode` graph created a secondary race: the first concurrent traverser to resolve a lazy subflow would clear the resolver on the shared node, so a second concurrent traverser could not re-resolve it. The fix replaces the write-back with a per-traverser `resolvedLazySubflows: Set<string>` — the shared node is never mutated.
- **Empty-array write now clears field** (`memory/utils.ts`) — `updateValue(obj, key, [])` and `deepSmartMerge(dst, [])` previously produced a silent no-op (spreading `[]` onto an existing array left the field unchanged). Both now treat an empty array as a replacement ("clear"), consistent with how `{}` is handled. Practically: `scope.customer.tags = []` now clears `tags` instead of being silently ignored.
  - Code that intentionally called `updateValue(obj, key, [])` or `deepSmartMerge(existing, [])` expecting a no-op must add an explicit `if (arr.length > 0)` guard.
- **Maximum recursion depth guard in `FlowchartTraverser.executeNode`** (`engine/traversal/FlowchartTraverser.ts`) — each recursive `executeNode` call keeps the calling frame on the V8 call stack (no tail-call optimization for `async/await`). An infinite loop or an excessively deep stage chain would overflow the stack with a cryptic "Maximum call stack size exceeded" error. The traverser now maintains a `_executeDepth` counter (try/finally, correctly decremented on both normal exit and throw). When the counter exceeds `MAX_EXECUTE_DEPTH` (500), a descriptive error naming the offending stage is thrown immediately, before any work is done for that stage. `RunOptions.maxDepth` overrides the class default for unusually deep pipelines; `maxDepth < 1` throws immediately at traverser construction.
- **`decide()` / `select()` rule errors are now surfaced in evidence** (`decide/decide.ts`) — the `when` function evaluator previously used an empty `catch {}` block, silently treating any exception as a non-match. Developers whose `when` functions threw (e.g. accessing a null property, undefined method) had no visibility that the rule was broken — it simply never matched. The catch block now captures the error message in `matchError?: string` on `FunctionRuleEvidence` and `FilterRuleEvidence`. `matched` is still `false` (pipeline resilience is preserved), but the error is now observable in the evidence for debugging. Non-`Error` throws are coerced with `String(e)`.
- **`generateOpenAPI` no longer walks `buildTimeStructure`** (`contract/openapi.ts`) — the description was re-derived post-build by recursively walking `buildTimeStructure`, which (1) violated the "collect during traversal" principle, (2) had no depth guard so a pathologically deep or cyclic structure could overflow the call stack, and (3) re-derived content that was already assembled. `chart.description` is now read directly — it is built incrementally by `FlowChartBuilder` as each stage is added and is complete by the time `build()` returns. No post-processing walk is performed. Injecting a deep or cyclic `buildTimeStructure` cannot affect the description or cause a stack overflow in the OpenAPI path.
- **Depth guard in `RuntimeStructureManager.buildNodeMap`** (`engine/handlers/RuntimeStructureManager.ts`) — `buildNodeMap` recursively registered all nodes in the O(1) lookup map with no depth limit. A pathologically deep or cyclic injected `buildTimeStructure` could overflow the call stack at executor construction time. The walk now silently returns when depth exceeds `MAX_NODE_MAP_DEPTH` (500); normal builder-produced charts are well below this limit.
- **Decider description now always includes branch list** (`builder/FlowChartBuilder.ts`) — when `addDeciderFunction` was called with a `deciderDescription`, the generated `chart.description` line included only the description text and omitted the branch IDs. Branch IDs are now always appended: `"2. Route — Route the request (branches: a, b)"`. Pipelines with no `deciderDescription` are unaffected (`"Decides between: a, b"` format unchanged).
- **`SelectorFnList` now sets `type='selector'` instead of `'decider'`** (`builder/FlowChartBuilder.ts`, `engine/handlers/RuntimeStructureManager.ts`) — selector nodes in `buildTimeStructure` and runtime snapshots were previously labeled `type='decider'`, making them indistinguishable from deciders by type alone. `'selector'` has been added to the `SerializedPipelineStructure.type` and `RuntimeStructureMetadata.type` unions; `SelectorFnList.end()` now sets `type='selector'`; `computeNodeType` returns `'selector'` for `selectorFn` nodes. Selectors continue to be distinguished by `hasSelector: true`. **Migration note (advanced API consumers only):** Code that checked `node.type === 'decider'` expecting to match both deciders and selectors (relying on the old bug) will no longer match selector nodes. Switch to `hasDecider`/`hasSelector` flag checks, which have always been the canonical discriminators and are unaffected by this fix. Code that only uses `hasDecider`/`hasSelector` requires no changes.
- **`typedFlowChart` deprecated** (`builder/typedFlowChart.ts`) — `flowChart<T>(name, fn, id)` is fully equivalent and auto-embeds the TypedScope factory at build time. `typedFlowChart` is now marked `@deprecated` with a migration guide.
- **`FlowChartExecutor` 9-param constructor deprecated in favor of options object** (`runner/FlowChartExecutor.ts`) — the positional-parameter constructor (9 params) was error-prone and hard to read at call sites. A `FlowChartExecutorOptions<TScope>` interface is now exported and accepted as the second argument: `new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true })`. The function-based second argument (`scopeFactory`) remains fully backward-compatible. Positional params 3–9 are deprecated with JSDoc `@deprecated` and will be removed in a future major version.
- **`StageContext` duplicate method aliases deprecated** (`memory/StageContext.ts`) — three pairs of duplicate methods had identical implementations: `get()` (alias of `getValue()`), `getFromRoot()` (alias of `getRoot()`), and `getFromGlobalContext()` (alias of `getGlobal()`). The duplicates caused confusion about which name was canonical and doubled the surface area of the `advanced` package export. All three are now marked `@deprecated` and delegate to their canonical counterparts. Internal callers (`ScopeFacade`, `baseStateCompatible`) have been updated to use the canonical names. `StageContextLike` now exposes `getGlobal?` as the canonical interface method (with `getFromGlobalContext?` kept for backward compatibility).
- **ReDoS guard in `ScopeFacade._isPolicyRedacted`** (`scope/ScopeFacade.ts`) — regex redaction patterns were tested against `key` strings without a length cap. A pathological regex (e.g. `/(a+)+/`) tested against an unboundedly long key could cause catastrophic backtracking and hang the process. Pattern testing is now skipped for keys longer than 256 characters (the `_MAX_PATTERN_KEY_LEN` constant). Exact-key matching (`policy.keys` array) is unaffected and still applies for keys of any length.
- **`nativeGet` no longer reads from the prototype chain** (`memory/pathOps.ts`) — `nativeGet` used plain bracket notation (`curr[seg]`) which followed the JavaScript prototype chain. An attacker-controlled path like `'__proto__'`, `'constructor'`, or `'toString'` could read `Object.prototype`, the `Object` constructor, or other inherited methods. The fix adds two guards per path segment: (1) a DENIED-key check (matching the existing write-path guard in `nativeSet`) and (2) an `Object.prototype.hasOwnProperty.call` check to restrict access to own properties only. `nativeHas` already used `hasOwnProperty`; `nativeGet` now matches it.
- **`defineContract` no longer mutates the original FlowChart** (`contract/defineContract.ts`) — The function previously wrote `chart.inputSchema = options.inputSchema` directly on the compiled chart object. Because compiled charts are meant to be shared across executors, this caused cross-contract contamination when the same chart was wrapped by multiple `defineContract` calls. The fix creates a prototype-linked view via `Object.create(chart)`: the view owns `inputSchema`, `outputSchema`, and `outputMapper` as own properties (shadowing the prototype), while all other properties (`root`, `stageMap`, methods) are inherited zero-copy. The original chart object is never touched. `RunContext` reads `outputMapper` from the chart directly (line 97), so shadowing all three fields ensures the contract's values are used in all code paths.

## [3.0.21]

### Added
- **Curated API reference** — five hand-written MDX pages in the Starlight docs site (`api/flowchart`, `api/decide`, `api/executor`, `api/recorders`, `api/contract`), each with signatures, parameter tables, and runnable examples. Replaces the TypeDoc redirect links in the sidebar.
- **"Try with your LLM" section in README** — highlights `toMCPTool()` with a one-liner example and links to the live Claude agent demo in the playground.

### Changed
- **Docs theme** — accent colour updated from orange to purple (`#7c6cf0` dark / `#4f46e5` light) to match playground palette. Body font changed to Inter; code font to JetBrains Mono — same as playground.
- **Docs auto-deploy** — `Deploy Docs` workflow now triggers on every push to `main` that touches `docs-site/**` or `src/**`, not only on release events.
- **README** — badge updated from "TypeDoc" to "Docs"; "25+ examples" updated to "37+"; documentation table links updated to Starlight guide and API reference pages; `npx footprintjs-setup` replaced with `npx degit` one-liner (bin entry was removed in v3.0.19).

### Fixed
- **`setup.sh` degit compatibility** — `CLAUDE.md` and `AGENTS.md` were silently skipped when running via `npx degit` because the script referenced `$PKG_DIR/../` which doesn't exist in a degit-downloaded directory. A `_copy_or_fetch` helper now falls back to fetching from the GitHub raw URL when the local path is absent.

## [3.0.20]

### Fixed
- **CI publish fix** — `pathBuilder.test.ts` imported `lodash.get` which was not listed in `devDependencies`, causing `npm publish` to fail with `ERR_MODULE_NOT_FOUND`. Replaced with a 3-line inline `getByPath` helper; no behaviour change.

## [3.0.19]

### Changed
- **Zero runtime dependencies** — replaced `lodash.get`, `lodash.has`, `lodash.set`, and `lodash.mergewith` with native implementations in `src/lib/memory/pathOps.ts`. All 1893 tests pass with identical behaviour. Prototype-pollution guards (`__proto__`, `constructor`, `prototype`) are preserved in the write path. This also fixes a latent edge case in `ScopeFacade._scrubFields` where a redaction field name containing a literal dot (e.g. `"key.sub"`) was not correctly redacted when that key existed as a flat property.
- **npm tarball no longer ships `ai-instructions/`** — IDE setup snippets (Cursor, Cline, Copilot, etc.) are available in the GitHub repo but are no longer bundled with the package. The `bin.footprintjs-setup` entry has been removed accordingly. This reduces unpacked size.

## [3.0.18] - 2026-03-28

### Added
- **`SECURITY.md`** — responsible disclosure policy with supported versions, private reporting link (GitHub private advisories), response timeline, scope definition (prototype pollution, redaction bypass, schema injection), and out-of-scope clarifications. Enterprise evaluators expect this.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1. Enforcement via GitHub's private discussion and report-abuse channels.
- **GitHub Issue Templates** — structured YAML templates for bug reports (Node/TS version, module format, repro snippet, area dropdown) and feature requests (problem-first framing, area dropdown). `config.yml` disables blank issues and links to playground + private security reporting.
- **GitHub PR Template** — checklist covering build, tests, coverage, `any` annotation policy, and CHANGELOG requirement.

### Changed
- **`package.json` description** updated to front-load high-signal search terms: `"Explainable backend flows — automatic causal traces, decision evidence, and MCP tool generation for AI agents"`. Previous description buried searchable terms.
- **`package.json` homepage** updated to docs site (`https://footprintjs.github.io/footPrint/`) — npm displays this prominently on the package page.
- **`package.json` keywords** expanded from 12 to 20: added `explainability`, `xai`, `ai-agent`, `mcp`, `decision-engine`, `rule-engine`, `audit-trail`, `openapi`, `tracing`. High-traffic terms that map to common npm/Google searches for this category of tool.

## [3.0.17] - 2026-03-27

### Fixed
- **`toMCPTool()` — MCP spec compliance** (3 fixes):
  - **`name` now uses `root.id`** (explicit machine-readable id) instead of lowercasing `root.name`. `flowChart('ProcessOrder', fn, 'process-order')` now emits `name: 'process-order'` instead of `'processorder'`.
  - **`name` is sanitized** to the MCP allowlist `[A-Za-z0-9_\-.]`. Any disallowed character is replaced with `_`. Leading/trailing underscores are trimmed.
  - **`inputSchema` is always present** (required by the MCP spec). Previously it was omitted when no `.contract()` was set. Now defaults to `{ type: 'object', properties: {}, additionalProperties: false }` (the MCP-recommended form for no-parameter tools).
- **`toOpenAPI()` — path now uses slugified `root.id`** instead of slugifying `root.name`. For `flowChart('ProcessOrder', fn, 'process-order')`, the path is now `/process-order` instead of `/processorder`.
- **`toOpenAPI()` — parameterized calls are no longer incorrectly cached**. Previously, calling `chart.toOpenAPI({ title: 'A' })` then `chart.toOpenAPI({ title: 'B' })` silently returned the first call's result. Now only no-options calls are cached; calls with options always recompute.
- **`MCPToolDescription.inputSchema` type changed from `unknown` to `JsonSchema`** (source-level breaking change — see migration below). This correctly models that `inputSchema` is always a JSON Schema object. Runtime behavior is unchanged for JS users.
- **`toMCPTool()` / `toOpenAPI()` now use `normalizeSchema` from `contract/schema.ts`** instead of a local duplicate with weaker typing.

#### Migration — `MCPToolDescription.inputSchema`
If you construct a `MCPToolDescription` literal manually (rare — most users call `.toMCPTool()` which constructs it), you must now include `inputSchema`. Add `inputSchema: { type: 'object', properties: {} }` for tools with no parameters.

## [3.0.16] - 2026-03-27

### Fixed
- **`flowChart<T>()` typed overload** — calling `flowChart<LoanState>(name, fn, id)` now infers `scope: TypedScope<LoanState>` in the stage function, instead of `scope: any`. Added two overloads: single-type-param for TypedScope usage, explicit-generics for advanced/ScopeFacade usage.
- **`StageFunction` return type widened to `TOut | void`** — stage functions that return nothing (i.e., `async (scope) => { scope.x = 1 }`) no longer produce a TypeScript error. `StageRunner` uses a cast internally to maintain `TOut` through the pipeline.
- **`T extends object` replaces `T extends Record<string, unknown>`** — interfaces without index signatures (e.g. `interface OrderState { total: number }`) can now be passed to `flowChart<T>()`, `decide()`, `select()`, `TypedScope<T>`, and `createTypedScope()`. Changed across `reactive/`, `decide/`, and `builder/`.
- **`RunOptions.input` widened to `unknown`** — `run({ input })` now accepts any value (including plain class instances), not just `Record<string, unknown>`. `validateInput` signature updated accordingly.
- **`addSubFlowChartBranch`/`addSubFlowChartNext`/`addSubFlowChartBranch`/`addLazySubFlowChartBranch` accept `FlowChart<any, any>`** — subflows have independent state types; parent and child no longer need to share the same `TOut`/`TScope`.
- **`addDeciderFunction`/`addSelectorFunction` `fn` param changed to `StageFunction<any, TScope>`** — decider functions return `DecisionResult` or branch IDs, not `TOut`; this resolves the overload mismatch when using `decide()`.

## [3.0.15] - 2026-03-27

### Changed
- **`ScopeFacade` removed from main `footprintjs` export** — `ScopeFacade` was previously accessible from the main entry point, which encouraged an anti-pattern (custom `scopeFactory` overrides) that broke TypedScope auto-embedding, silently dropped `executionEnv`, and caused incompatibilities in subflow inheritance. `ScopeFacade` is now only available via `footprintjs/advanced` for internal/testing use. The correct pattern for observing reads/writes is `executor.attachRecorder(r)` — no custom `scopeFactory` needed.
- **Internal tests updated** — Two scenario test files that explicitly passed `createTypedScopeFactory<T>()` to `FlowChartExecutor` were cleaned up to use `new FlowChartExecutor(chart)` (the factory is auto-embedded by `.build()` since v3.0.3).
- **API conformance test moved** — The `ScopeFacade` conformance test moved from the "Public Exports" block to the "Removed from Main Export" block to correctly document the intent.

## [3.0.14] - 2026-03-27

### Fixed
- **`RunnableFlowChart` extends `builder.FlowChart` instead of `engine.FlowChart`** — `runner/RunnableChart.ts` was importing `FlowChart` from `engine/types.js`, whose `buildTimeStructure` is optional and wider (9-member `type` union). This made `RunnableFlowChart` unassignable to `builder.FlowChart` (which has a required, narrower `buildTimeStructure`), causing a type error when passing the result of `.build()` to `addSubFlowChartBranch` / `addSubFlowChartNext`. Fixed by importing `FlowChart` from `builder/types.js` — which already carries `buildTimeStructure` (required), `description`, `stageDescriptions`, `inputSchema`, `outputSchema`, and `outputMapper`, making the redundant field re-declarations in `RunnableFlowChart` unnecessary. `runner → builder → engine` has no circular dependency.
- **Docs: `recording.mdx` narrative output corrected** — example output comments showed the old `[Set]`/`[Read]` format (e.g. `[Set] temperature = 38.5`). Updated to match the current `CombinedNarrativeRecorder` output: `Step N: Write key = value` / `Step N: Read key = value` with quoted strings for string values.
- **Docs: `self-describing.mdx` `defineContract` section removed** — `defineContract` is deliberately not exported from the public API (enforced by conformance test — "use `.contract()`"). The section documented an unreachable import. Replaced with a corrected JSON Schema section referencing only `.contract()`.

## [3.0.13] - 2026-03-26

### Added
- **`@typescript-eslint/no-var-requires` lint rule enabled** — was explicitly disabled (`'off'`), allowing `require()` calls in TypeScript source. Now set to `'error'`. Catches any future ESM/CJS incompatibility at `git commit` time (pre-commit hook runs ESLint). The `require()` that broke `.toOpenAPI()` in ESM (fixed in v3.0.12) would have been caught at commit time with this rule active.
- **Type structural compatibility test suite** (`test/api-conformance/type-structural-compat.test.ts`) — 5 `expectTypeOf` assertions that run on every `npm test` and in the release pipeline (Gate 3):
  - `RunnableFlowChart` is assignable to `FlowChart` (the v3.0.9 regression)
  - `RunnableFlowChart.buildTimeStructure` is required, not optional
  - `SubflowExecutor.RunStageFn` equals `handlers/types.RunStageFn` (same-shape-different-name duplicate class)
  - All four handler callback types resolve (non-never) from their canonical source
  - Public `ScopeFactory` accepts a 4-param implementation with `executionEnv` (catches if export reverts to 3-param memory version)

## [3.0.12] - 2026-03-26

### Fixed
- **`toOpenAPI()` now works correctly in ESM** — `normalizeSchema()` in `RunnableChart.ts` used a `require()` call to load `zodToJsonSchema`, which throws `ReferenceError: require is not defined` in ESM environments. The error was swallowed by a try/catch, causing `.toOpenAPI()` to silently emit a spec with no request/response schemas when the user's `inputSchema`/`outputSchema` was a Zod schema. Fixed by replacing `require()` with a static `import { zodToJsonSchema } from '../contract/schema.js'`.
- **`ExecuteStageFn` in `SubflowExecutor` was a structural duplicate of `RunStageFn`** — identical four-parameter signature, different name, same directory. `SubflowExecutor` already re-exported `CallExtractorFn` from `handlers/types.ts` (added in v3.0.11) but kept its own `ExecuteStageFn`. Replaced with `RunStageFn` from `handlers/types.ts` throughout. The constructor parameter `executeStage` now correctly typed as `RunStageFn`. No runtime change — type-only.

## [3.0.11] - 2026-03-26

### Fixed
- **Eliminated 5 duplicate type definitions across the codebase** — each was a structural mismatch risk (same class of bug as v3.0.10's `TraversalExtractor`):
  - `ScopeProtectionMode`: deleted redefinition from `builder/types.ts`; now imports canonical from `scope/protection/types.ts`
  - `FlowControlType` + `FlowMessage`: deleted duplicate definitions from `engine/types.ts`; now re-exported from `memory/types.ts` (their canonical home)
  - `ExecuteNodeFn`, `CallExtractorFn`, `RunStageFn`, `GetStagePathFn`: consolidated from 3 separate handler files into a single `engine/handlers/types.ts`; `SelectorHandler` now imports from there instead of `DeciderHandler`
  - `OpenAPIOptions` in `runner/RunnableChart.ts`: renamed to `ChartOpenAPIOptions` (matching the public export alias that was already in `index.ts`) to avoid collision with `contract/types.ts`'s `OpenAPIOptions`
  - `ScopeFactory` public export: `index.ts` now exports the 4-param version from `engine/types.ts` (includes `executionEnv`) instead of the 3-param version from `memory/types.ts`. Non-breaking — 3-param implementations remain assignable.
- **Duplicate type detector added** (`scripts/check-dup-types.mjs` / `npm run check:dup-types`): scans `src/` for exported type/interface names defined in more than one file; fails the release pipeline if any new duplicates are introduced. Allowlisted entries include a documented explanation of why consolidation is not currently possible.

## [3.0.10] - 2026-03-26

### Fixed
- **`RunnableFlowChart` now assignable to `FlowChart` in `addSubFlowChartBranch`** — structural type mismatch caused by `TraversalExtractor` being defined twice with incompatible parameter types (`unknown` in `builder/types.ts` vs `StageSnapshot` in `engine/types.ts`). Fixed by removing the duplicate definition from `builder/types.ts` and re-exporting the canonical one from `engine/types.ts`. Also added `buildTimeStructure: SerializedPipelineStructure` (required) to `RunnableFlowChart`, narrowing the optional field inherited from `FlowChart`. Runtime was never affected — type-only bug.

## [3.0.9] - 2026-03-26

### Added
- **`narrative()` exported from main `'footprintjs'` package** — previously required a sub-path import (`'footprintjs/recorders'`). Now importable directly: `import { flowChart, decide, narrative } from 'footprintjs'`.

### Changed
- **README Quick Start** — restructured around the 3-step pattern (define state → build flowchart → run), and replaced `FlowChartExecutor` with `chart.recorder(narrative()).run()`. `FlowChartExecutor` remains in the public API for advanced use cases (multiple recorders, redaction policy, getSnapshot).

## [3.0.8] - 2026-03-26

### Fixed
- **`RunnableFlowChart` now includes builder metadata fields** — `description`, `stageDescriptions`, `outputSchema`, and `outputMapper` were only on the builder's internal `FlowChart` type and were lost in the `RunnableFlowChart` interface. Now explicitly declared on `RunnableFlowChart`, matching what `FlowChartBuilder.build()` actually puts on the object. Fixes TypeScript errors in any code that accesses these fields on the built chart.

## [3.0.7] - 2026-03-26

### Added
- **5-tier test coverage for subflow redaction boundary** — 7 new tests across all tiers:
  - *Property*: invariant that once a key is in `_redactedKeys`, every subsequent `setValue` without `shouldRedact` still fires redacted
  - *Scenario*: TypedScope top-level write path + cross-scope write via shared `_redactedKeys` Set (the outputMapper pattern)
  - *Security*: end-to-end `FlowChartExecutor` test asserting raw PII never appears in parent narrative after subflow→outputMapper transfer
- **Sample `17-subflow-redaction`** — demonstrates the subflow PII boundary pattern: payment subflow marks `cardNumber` redacted per-call, `outputMapper` transfers it to parent without any explicit flag, parent narrative shows `[REDACTED]` throughout

## [3.0.6] - 2026-03-26

### Fixed
- **`setValue` inherits dynamic redaction state** — if a key was previously marked redacted (via `setValue(key, val, true)` or policy), subsequent `setValue(key, newVal)` calls without an explicit `shouldRedact` flag now also fire as redacted. Previously, only the static policy was checked; the dynamic `_redactedKeys` set was ignored on writes. This closes the outputMapper edge case: when a subflow marks a key redacted and `outputMapper` writes it to the parent scope, the write event is now correctly redacted. 2 new tests added.

## [3.0.5] - 2026-03-26

### Fixed
- **`outputMapper` shallow-clones subflow state** — previously passed the live `sharedState` reference to `outputMapper`, risking aliasing bugs if the mapper mutated the object. Now passes `{ ...sharedState }` (shallow clone). Documentation added explaining that `outputMapper` receives the full subflow scope (not just declared outputs) for TypedScope subflows, and that PII key redaction across subflow boundaries is the caller's responsibility until the full ScopeFacade-level redaction layer lands.

## [3.0.4] - 2026-03-25

### Fixed
- **`outputMapper` now receives subflow scope state** — TypedScope subflow stages return `void`, so `outputMapper` previously received `undefined` as its first argument. It now falls back to the subflow's `sharedState` when the stage function returns `undefined`, making `outputMapper` usable with TypedScope subflows.
- **`05-subflow` sample** — added `outputMapper` to properly propagate payment subflow results back to the parent scope. Sample previously showed "on hold -- payment undefined" due to missing output mapping.
- **All samples** — added `executor.enableNarrative()` to 15 samples that called `getNarrative()` without enabling it; all samples now produce full narrative output.

### Added
- **Sample integration tests** — 17 vitest snapshot tests in `footprint-samples/test/integration/` covering: linear pipeline, decider, decide()/select() evidence, loan application, and subflow. Snapshots are golden files that break on any API regression. Added as gate 6a in the release script.

## [3.0.3] - 2026-03-25

### Fixed
- **Re-export `createTypedScopeFactory`** from main API — needed by playground and custom builder extensions that create `FlowChartBuilder` subclasses.

## [3.0.2] - 2026-03-25

### Added
- **7-gate release pipeline** — release script now verifies: clean tree, doc check, API conformance (47 tests), build, full suite (1874 tests), sample projects, CHANGELOG entry. No release gets out with stale docs or broken samples.

## [3.0.1] - 2026-03-25

### Fixed
- **All documentation updated to v3 API** — 19 `.md` files, 156 outdated references fixed (README, CLAUDE.md, AGENTS.md, all AI instructions, guides).
- **Pre-release doc check** — `scripts/check-docs.sh` blocks releases if any `.md` file references removed APIs. Integrated into `release.sh`.

## [3.0.0] - 2026-03-25

### Breaking
- **Removed `typedFlowChart()`** from public API — use `flowChart<T>()` instead. Auto-embeds TypedScope factory.
- **Removed `createTypedScopeFactory()`** from public API — auto-embedded by `flowChart<T>()`.
- **Removed `setEnableNarrative()`** from builder — use `.recorder(narrative())` at runtime.
- **Removed `setInputSchema()` / `setOutputSchema()` / `setOutputMapper()`** from builder — use `.contract({ input, output, mapper })`.
- **Removed `generateOpenAPI()` / `defineContract()`** from public API — use `chart.toOpenAPI()` and `.contract()` on builder.
- **`flowChart()` now auto-embeds TypedScope factory** — stage functions receive TypedScope, use typed property access (`scope.name = 'Alice'`).

### Added
- **API Conformance Tests** — 47 tests verify every v2 design decision. Run `npx vitest run test/api-conformance/` before every release.

## [2.0.0] - 2026-03-24

### Added
- **`chart.run()`** — Execute a chart directly without creating a `FlowChartExecutor`. Returns `RunResult` with `state`, `output`, `narrative`.
- **`chart.recorder(r).run()`** — d3-style chainable run configuration. Attach recorders and redaction per-run.
- **`RunContext`** — Ephemeral run configuration returned by `chart.recorder()` and `chart.redact()`. Distinct type from `FlowChart`.
- **`chart.toOpenAPI()`** — Generate OpenAPI 3.1 spec from chart metadata and contract. Cached.
- **`chart.toMCPTool()`** — Generate MCP tool description from chart metadata. Cached.
- **`.contract({ input, output, mapper })`** — Unified API replacing `setInputSchema()`, `setOutputSchema()`, `setOutputMapper()`.
- **`footprintjs/recorders`** — Recorder factory functions: `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()`.
- **Auto-embedded scopeFactory** — `typedFlowChart<T>()` embeds `createTypedScopeFactory<T>()` into the chart. `FlowChartExecutor` reads it automatically.

### Changed
- **`FlowChartExecutor` scopeFactory parameter is now optional** — reads `chart.scopeFactory` if not provided.
- **`FlowChartBuilder.build()` returns `RunnableFlowChart`** — extends `FlowChart` with `.run()`, `.recorder()`, `.redact()`, `.toOpenAPI()`, `.toMCPTool()`.
- **All samples updated** — no `createTypedScopeFactory` needed. `FlowChartExecutor(chart)` is enough.

## [1.0.1] - 2026-03-24

### Fixed
- **TypedScope proxy unwrap** — `structuredClone` in `TransactionBuffer` failed when assigning proxy-wrapped values (e.g., `scope.backup = scope.customer`). Proxy values are now auto-unwrapped via JSON round-trip before storing. Regression tests added.
- **AI coding instructions** — All AI tool instruction files (Copilot, Cursor, Kiro, Windsurf, Cline, AGENTS.md) updated to use `typedFlowChart<T>()`, `decide()`/`select()`, and typed property access. Previously referenced deprecated `ScopeFacade`/`getValue`/`setValue` API.

## [1.0.0] - 2026-03-22

### Added
- **`TypedScope<T>`** — Reactive proxy for typed property access. `scope.creditScore = 750` instead of `scope.setValue('creditScore', 750)`. Deep nested writes (`scope.customer.address.zip = '90210'`), array copy-on-write (`scope.tags.push('vip')`), and 17 `$`-prefixed escape hatches (`$getValue`, `$getArgs`, `$getEnv`, `$break`, `$debug`, `$metric`, etc.). New `reactive/` internal package.
- **`decide()` / `select()`** — Decision reasoning capture. Auto-captures WHY a decider chose a branch or a selector picked paths. Two `when` formats: function `(s) => s.creditScore > 700` (auto-captures reads via temp recorder) and Prisma-style filter `{ creditScore: { gt: 700 } }` (captures operators + thresholds). Evidence flows into narrative: "It evaluated creditScore 750 gt 700, and chose Approve." New `decide/` internal package.
- **`typedFlowChart<T>()`** — Convenience builder that infers `TypedScope<T>` for all stage functions.
- **`createTypedScopeFactory<T>()`** — Pairs with `typedFlowChart<T>()` for the executor.
- **`FilterOps<V>`** — 8 Prisma-style operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`.
- **`DecisionResult` / `SelectionResult`** — Symbol-branded results from `decide()` / `select()`. Engine detects them via `DECISION_RESULT` Symbol and extracts evidence automatically.
- **API docs** — TypeDoc auto-generated and deployed to GitHub Pages on every release.
- **Dev-mode circular reference detection** — `enableDevMode()` activates runtime detection of circular references in `setValue()` / `updateValue()`.

### Changed
- **`TypedScope<T>` is now the recommended API** — `getValue()` / `setValue()` still work via `ScopeFacade` but TypedScope eliminates the cast-hell DX problem. All samples and documentation updated.
- **Evidence-aware narrative** — `CombinedNarrativeRecorder.onDecision()` and `onSelected()` render structured evidence when available. Filter evidence shows operators and thresholds with pass/fail markers. Function evidence shows which keys were read and their values.

### Fixed
- **Spurious "Read getValue" in narrative** — `decide()` accessor helpers now check `$getValue` before `getValue` to avoid triggering TypedScope's Proxy get trap.
- **Inline `import()` types** — Converted all inline type imports in narrative types to explicit top-level imports for consistency.

## [0.18.1] - 2026-03-20

### Fixed
- **`Recorder.clear()` lifecycle** — Scope recorders are now cleared before each `run()`, preventing cross-run data accumulation. `MetricRecorder` and `DebugRecorder` implement it.
- **`Recorder.toSnapshot()` in snapshots** — Scope recorders implementing `toSnapshot()` (like `MetricRecorder`) are now included in `executor.getSnapshot().recorders` alongside FlowRecorder data.
- **Documentation sweep** — All samples, guides, and skill files updated to use `executor.attachRecorder()` instead of custom `scopeFactory` boilerplate.

## [0.18.0] - 2026-03-20

### Added
- **`executor.attachRecorder(recorder)`** — Attach scope recorders (MetricRecorder, DebugRecorder, custom) to the executor with a one-liner. No more custom `scopeFactory` boilerplate. Also adds `detachRecorder(id)` and `getRecorders()`. Works alongside narrative, FlowRecorders, and redaction.
- **`Recorder.clear()` lifecycle hook** — Optional `clear?()` on the `Recorder` interface. Called before each `executor.run()` to prevent cross-run accumulation. `MetricRecorder` and `DebugRecorder` implement it.
- **`Recorder.toSnapshot()` lifecycle hook** — Optional `toSnapshot?()` on the `Recorder` interface. Scope recorders with this method are now included in `executor.getSnapshot().recorders` alongside FlowRecorder snapshots.

## [0.17.3] - 2026-03-20

### Fixed
- **Narrative wording for parallel/selected** — `onFork` now says "Forking into N parallel paths" (future tense) instead of "N paths were executed in parallel" (past tense). `onSelected` says "selected for execution" instead of "were selected". Matches traversal order where the announcement fires before execution.

## [0.17.2] - 2026-03-20

### Fixed
- **`traversalContext` on all FlowRecorder events** — `onFork`, `onSelected`, `onDecision`, `onLoop`, `onSubflowEntry`, `onSubflowExit`, and `onError` from handlers now pass `traversalContext` from the traverser. Previously only `onStageExecuted` and `onNext` carried it. This ensures all narrative entries have `stageId` for UI sync.

## [0.17.1] - 2026-03-20

### Added
- **`stageId` on all narrative entries** — `CombinedNarrativeEntry` now carries `stageId` (from `TraversalContext.stageId`) on every entry type: stage, step, condition, fork, subflow, loop, break, error. This is the stable build-time identifier (matches spec node `id`) that enables exact UI sync between the execution tree timeline and recorder entries — no name matching needed.

## [0.17.0] - 2026-03-19

### Added
- **Per-subflow stage numbering** — `CombinedNarrativeRecorder` resets stage counters when entering a subflow, so stages inside subflows start at "Stage 1" instead of continuing the parent's count. Counters reset on re-entry too.
- **Recorder snapshots in `getSnapshot()`** — `FlowRecorder` interface gains optional `toSnapshot()` method. `FlowChartExecutor.getSnapshot()` collects data from recorders that implement it into a `recorders[]` field on `RuntimeSnapshot`. `MetricRecorder` and `ManifestFlowRecorder` implement `toSnapshot()`.
- **`RecorderSnapshot` and `RuntimeSnapshot` types** — Exported from the public API for consumers building snapshot-aware UIs.
- **All FlowEvent types exported** — `FlowStageEvent`, `FlowDecisionEvent`, `FlowBreakEvent`, `FlowNextEvent`, `FlowForkEvent`, `FlowSelectedEvent` now exported from `footprintjs` (previously only available via `footprintjs/advanced`).

### Fixed
- **`onDecision` missing `subflowId` in `flushOps`** — Buffered data ops for decider stages inside subflows were tagged with `undefined` subflowId. Now correctly passes `event.traversalContext?.subflowId`.

## [0.16.0] - 2026-03-18

### Added
- **TraversalContext on all FlowRecorder events** — Every recorder event now carries an optional `traversalContext` with `stageId`, `parentStageId`, `subflowId`, `subflowPath`, `depth`, `loopIteration`, and `forkBranch`. Created by the traverser during DFS traversal, passed as read-only data. Enables third-party recorders (Datadog, OpenTelemetry, Elastic) to build execution trees from `parentStageId` without post-processing.
- **`CombinedNarrativeEntry.subflowId`** — Narrative entries are now tagged with the subflow they belong to. Set from `event.traversalContext.subflowId` (from the traverser), not a manual stack (eliminates parallel subflow interleaving bugs).
- **`CombinedNarrativeRecorder.getEntriesBySubflow()`** — Returns entries grouped by subflowId for structured access.

### Changed
- **CombinedNarrativeRecorder** — Removed manual `subflowStack` in favor of `traversalContext.subflowId` from events. Parallel subflows now tag correctly (each branch gets its own context from the traverser).

## [0.15.2] - 2026-03-18

### Fixed
- **Subflow trace matching in drill-down** — `NodeResolver.resolveSubflowReference` now uses the inner root's `id` (`subflowDef.root.id`) instead of the mount node's `id`. Previously, the subflow execution tree's root stage got the mount ID (e.g., "auth"), which didn't match the spec node ID (e.g., "validate-token"), causing trace overlay to fail inside subflow drill-down views.

## [0.15.1] - 2026-03-18

### Fixed
- **Decider continuation stage visible in snapshot** — Decider branches now use `createChild` instead of `createNext` for the selected branch context. Previously, the branch occupied the `context.next` slot, causing the continuation stage (the node after `.end()`) to share the branch's context and become invisible in the execution snapshot. Now the branch appears as `context.children[0]` and the continuation gets its own `context.next`, producing the correct trace: Decider → [Branch] → Continuation.

## [0.15.0] - 2026-03-18

### Added
- **Lazy subflow resolution (`addLazySubFlowChartBranch`)** — Defers subflow tree cloning until first execution. Stores a factory function instead of eagerly expanding the subflow tree at build time. Enables the "graph-of-services" pattern at scale — 50+ service branches with zero build-time cost for unselected ones.
  - `addLazySubFlowChartBranch()` on `DeciderList` and `SelectorFnList`
  - `addLazySubFlowChart()` — lazy parallel child
  - `addLazySubFlowChartNext()` — lazy linear next
  - `StageNode.subflowResolver` — factory function, resolved at most once per execution
  - `SerializedPipelineStructure.isLazy` — visualization hint (dashed border + cloud icon in UI)
  - Engine Phase 0a: resolves lazy subflows before Phase 0 classify
- **10 unit tests** covering decider, selector, linear, parallel, spec flags, and resolver idempotency.

## [0.14.4] - 2026-03-17

### Added
- **Structural-only dynamic subflows (pre-executed subflow pattern)** — A stage function can now return a StageNode with `isSubflowRoot: true` + `subflowDef: { buildTimeStructure }` but no `subflowDef.root`. The engine annotates the runtime structure for visualization without invoking SubflowExecutor. Use case: HTTP request tracing where the inner flow already executed in the route handler — only its shape needs to be attached for Trace Studio drill-down.
- **`isStageNodeReturn` recognizes `isSubflowRoot`** — `isSubflowRoot === true` is now a valid continuation marker for dynamic StageNode return detection. Previously only `children`, `next`, and `nextNodeSelector` qualified.
- **46 new tests** — Full 5-type test coverage (unit, scenario, property, boundary, security) for the structural subflow feature.

### Changed
- **`subflowDef.root` is now optional** — The `StageNode.subflowDef` type allows omitting `root` for structural-only subflows. When `root` is absent, `autoRegisterSubflowDef` skips subflow registration and the traverser falls through to normal continuation.

### Fixed
- **Deep-copy of `buildTimeStructure` in `RuntimeStructureManager.updateDynamicSubflow`** — The stored `subflowStructure` is now a deep copy (via `JSON.parse(JSON.stringify())`), preventing external mutation of the annotation after execution.

## [0.14.2] - 2026-03-17

### Fixed
- **Snapshot `id` field now reflects builder stage ID** — `StageContext.getSnapshot()` was setting `id` to `runId` (empty string for sequential stages) instead of the builder's stage identifier. This broke trace overlay matching when runtime snapshots were merged across services (prefixed `name` was used as fallback). Added required `stageId` field to `StageContext`, propagated from builder `StageNode.id` through traverser and executor.

## [0.14.1] - 2026-03-16

### Fixed
- **ESM import compliance** — All internal imports now use explicit `.js` extensions for proper ESM module resolution. Added `moduleResolution: "node"` to tsconfig for compatibility.

## [0.14.0] - 2026-03-16

### Fixed
- **Subflow internal narrative events** — `SubflowExecutor` now fires `onStageExecuted`, `onNext`, and `onBreak` to the shared `CombinedNarrativeRecorder`, matching what `FlowchartTraverser` does for top-level stages. Previously, `getNarrativeEntries()` only contained "Entering/Exiting" markers for subflows with no internal stage detail — subflow drill-down views showed placeholder text instead of real narrative.

### Added
- **`icon` hint on spec types** — Optional `icon` field on `SerializedPipelineStructure` and `FlowChartSpec` for semantic visualization hints (e.g., `"llm"`, `"tool"`, `"rag"`, `"agent"`).

## [0.13.0] - 2026-03-15

### Added
- **`ComposableRunner` interface** — convention for runners that expose their internal flowChart via `toFlowChart()`. Enables mounting any runner as a subflow in a parent flowChart for UI drill-down into nested execution. Type-only export (zero runtime cost).
- **`getSubtreeSnapshot(snapshot, path, narrativeEntries?)`** — navigate the execution snapshot tree by slash-separated subflow path (e.g. `"sf-payment"` or `"sf-outer/sf-inner"`). Returns `SubtreeSnapshot` with `{ subflowId, executionTree, sharedState, narrativeEntries }`. Pass `executor.getNarrativeEntries()` as third arg to get narrative scoped to that subflow.
- **`listSubflowPaths(snapshot)`** — discover all available drill-down targets in a snapshot. Returns array of slash-separated subflow ID paths from `subflowResults`.

## [0.12.0] - 2026-03-14

### Added
- **`scope.getEnv()` — per-executor infrastructure context.** Introduces `ExecutionEnv`, a closed frozen type `{ signal?, timeoutMs?, traceId? }` that propagates through nested subflows like `process.env` for flowcharts. Pass via `executor.run({ env: { traceId, signal, timeoutMs } })`, read inside any stage with `scope.getEnv()`. Three scope access tiers: `getValue()` (tracked mutable state), `getArgs()` (frozen business input), `getEnv()` (frozen infrastructure context). Subflows inherit env automatically — no explicit mapping needed.

## [0.11.0] - 2026-03-14

### Fixed
- **`loopTo()` runtime execution** — `loopTo(stageId)` built the graph structure correctly but the engine couldn't execute the loop at runtime. The bare reference node had no `fn` and no stageMap entry, causing "must define: embedded fn OR a stageMap entry" errors. Fixed by routing `isLoopRef` nodes through `ContinuationResolver` for proper ID resolution, iteration tracking, and narrative generation. Works with linear chains, mid-chain targets, and decider→branch→loopTo patterns.
- **`loopTo()` build-time validation** — `loopTo(stageId)` now throws immediately if `stageId` is not a registered stage ID, catching name-vs-id mistakes at build time.

### Changed
- **Single canonical `StageNode` type** — Eliminated the duplicate `StageNode` definition in `builder/types.ts`. Builder now re-exports the engine's canonical `StageNode` via `import type` (zero runtime dependency). Same consolidation for `ILogger`, `StageFunction`, `StreamCallback`, `StreamHandlers`, `SubflowMountOptions`.
- **`StageNode.id` enforced at engine level** — The engine type now has `id: string` (required), matching the builder API which always required `id` since v0.10.0. Removed 16 `node.id ?? node.name` / `node.id || node.name` fallback patterns that were dead code.
- **`PipelineStageFunction` deprecated** — Use `StageFunction` instead. The old name is preserved as a type alias for backward compatibility.

## [0.10.3] - 2026-03-14

### Changed
- **README restructured** — Condensed from 590 lines / 16 sections to ~130 lines / 7 sections. Leads with the problem and loan trace, not a toy example. Fixed Quick Start to use current API (`id` required since v0.10.0). Added Live Demo badge.
- **Hero GIF** — Added animated demo GIF (`assets/hero.gif`) showing the BTS visualization with flowchart, memory inspector, and causal trace.
- **API Reference moved to docs** — Full Builder, Executor, ScopeFacade, and Contract method tables now in `docs/guides/api-reference.md`.
- **Performance benchmarks moved to docs** — Benchmark results and guidance now in `docs/guides/performance.md`.

## [0.10.2] - 2026-03-13

### Added
- **AI coding tool instructions** — Ship built-in instructions for Claude Code (`CLAUDE.md` + interactive skill), OpenAI Codex (`AGENTS.md`), GitHub Copilot, Cursor, Windsurf, Cline, and Kiro. Every file teaches the AI assistant the Builder, Executor, ScopeFacade APIs, recorder system, core principle (collect during traversal), and anti-patterns.
- **`npx footprintjs-setup`** — Interactive installer that copies the right instruction files for your AI coding tool into your project. Files ship inside the npm package under `ai-instructions/`.
- **README: AI Coding Tool Support section** — Documents all 7 supported tools with quick setup instructions.

## [0.10.0] - 2026-03-12

### Breaking Changes
- **`fn` and `id` are now required** on `.start()`, `.addFunction()`, `.addStreamingFunction()`, `.addDeciderFunction()`, `.addSelectorFunction()`, and `flowChart()` factory.
- **`addStreamingFunction` parameter order changed** — new: `(name, fn, id, streamId?, description?)` (was: `name, streamId?, fn?, id?, description?`).
- **`StageNode.id` is now required** in the type definition. All nodes must have a stable identifier for visualization matching and branch aggregation.

### Why
Optional `fn` caused silent stageMap resolution bugs. Optional `id` forced the UI to guess identifiers from `name`, breaking visualization matching. Making both required ensures every stage is explicit and identifiable.

## [0.9.2] - 2026-03-12

### Added
- **`stageReads` tracking** — `StageContext.getValue()` now records pre-namespace keys and their values at read time in `_stageReads`, exposed via `StageSnapshot.stageReads`. Enables the memory view to show a "read cursor" — which keys each stage accessed.
- **`stageWrites` tracking** — `StageContext.setObject()` / `updateObject()` record pre-namespace keys and values in `_stageWrites`, exposed via `StageSnapshot.stageWrites`. The memory view can now show actual `setValue()`/`updateValue()` data separately from diagnostic logs.

### Fixed
- **`writeTrace` no longer leaks into diagnostic logs** — `commit()` previously called `this.debug.addLog('writeTrace', commitBundle.trace)`, polluting the diagnostic layer with commit-level data that already exists in the event log. Removed.

## [0.9.1] - 2026-03-12

### Fixed
- **Subflow metadata no longer pollutes diagnostic logs** — engine internal keys (`isSubflowContainer`, `subflowResult`, `mappedInput`, `subflowName`, `hasSubflowData`, etc.) were previously written to parent stage logs via `addLog()`, leaking into the user's scope/memory. These keys are now routed exclusively through the proper `subflowResultsMap` channel.
- **`RuntimeSnapshot.subflowResults`** — new optional field on `RuntimeSnapshot` exposes subflow execution results (keyed by subflowId) via `FlowChartExecutor.getSnapshot()`. Previously only available via the separate `getSubflowResults()` method.

## [0.9.0] - 2026-03-12

### Added
- **ManifestFlowRecorder** — lightweight subflow catalog built during traversal
  - Builds a tree of subflow IDs, names, and descriptions as a side effect of execution
  - `getManifest()` returns the tree (defensive copy); `getSpec(subflowId)` returns full specs on demand
  - First-write-wins semantics for spec registration; `clear()` resets between runs
  - Suitable for LLM navigation: include manifest in snapshot, pull specs only when needed
- **Subflow event enrichment** — `FlowSubflowEvent` widened with `subflowId` and `description`
  - `onSubflowEntry` / `onSubflowExit` now carry subflow identifier and builder description
  - New `onSubflowRegistered` hook fires when dynamic subflows are attached at runtime
  - `FlowSubflowRegisteredEvent` carries subflowId, name, description, and specStructure
- **StageSnapshot enrichment** — `description` and `subflowId` fields on `StageSnapshot`
  - Builder descriptions propagate through `StageContext.getSnapshot()` into execution tree
  - Subflow entry points carry their `subflowId` for downstream consumers
- **FlowRecorder.clear()** — optional lifecycle hook for stateful recorders
  - `FlowChartExecutor.run()` calls `clear()` on all recorders before each run
  - Prevents cross-run accumulation without `instanceof` checks
- `executor.getSubflowManifest()` and `executor.getSubflowSpec(id)` convenience methods
- `ManifestFlowRecorder`, `ManifestEntry`, `FlowSubflowEvent`, `FlowSubflowRegisteredEvent` exported from `footprintjs`
- Core design principle documented: all data collection is a side effect of traversal
- 41 new tests across 5 tiers: unit (15), scenario (7), property (4), boundary (9), security (3)

### Changed
- `IControlFlowNarrative.onSubflowEntry()` / `onSubflowExit()` signatures widened (backward-compatible)
- `ControlFlowNarrativeGenerator` includes description in subflow entry sentences when available
- `NarrativeFlowRecorder` includes description in subflow entry sentences when available

## [0.8.0] - 2026-03-10

### Added
- **Structured error preservation** — errors flow through the narrative pipeline as structured objects, not flat strings
  - `extractErrorInfo(error)` — extracts `StructuredErrorInfo` from any thrown value (InputValidationError, Error, non-Error)
  - `formatErrorInfo(info)` — renders structured error to human-readable string at rendering boundaries
  - `StructuredErrorInfo` type: `{ message, name?, issues?, code?, raw }`
  - `FlowErrorEvent.structuredError` — carries full structured details to FlowRecorders
  - `NarrativeFlowRecorder` enriches error sentences with field-level validation issues
  - Hardened against adversarial inputs: throwing getters, null-prototype objects, Proxy errors
  - Deep-clones issues array for mutation safety
- `extractErrorInfo`, `formatErrorInfo`, `StructuredErrorInfo`, `FlowErrorEvent` exported from `footprintjs`
- 37 new tests across 5 tiers: unit (9), scenario (6), property-based (5), boundary (6), security (11)

### Changed
- `IControlFlowNarrative.onError()` — `error` parameter is now **required** (was optional)
- `FlowErrorEvent.structuredError` — field is now **required** (was optional)

### Fixed
- `SubflowExecutor` — added missing `narrativeGenerator.onError()` call in catch block (pre-existing omission)

## [0.7.0] - 2026-03-10

### Added
- **Schema library** (`src/lib/schema/`) — unified schema detection and validation gateway
  - `detectSchema(input)` — single function replaces 3 separate Zod detection strategies
  - `SchemaKind` type: `'zod' | 'parseable' | 'json-schema' | 'none'`
  - `validateAgainstSchema(schema, data)` — safe result-type validation for any schema kind
  - `validateOrThrow(schema, data)` — convenience wrapper that throws on failure
  - `InputValidationError` — structured error with `.issues: ValidationIssue[]` and `.cause`
  - Lightweight JSON Schema validation (required fields + type checks, no ajv dependency)
  - `extractIssuesFromZodError()` — extract structured issues from Zod or duck-typed errors
- **Runtime input validation** in `FlowChartExecutor.run()`
  - Validates `options.input` against `flowChart.inputSchema` before execution starts
  - Contract-defined `inputSchema` auto-propagates to chart via `defineContract()`
- **Readonly input protection** (`src/lib/scope/protection/readonlyInput.ts`)
  - Stage inputs are frozen to prevent accidental mutation across stages
- All schema types and functions exported from `footprintjs` public API

### Changed
- `isZodSchema()` in contract/schema.ts now delegates to `isZod()` from schema library (marked `@deprecated`)
- `isZodNode()` in scope/state/zod delegates to `detectSchema()` from schema library (marked `@deprecated`)
- Test suite migrated from `jest.fn()` to `vi.fn()` across 24+ test files (vitest compatibility)

## [0.6.0] - 2026-03-09

### Added
- **RedactionPolicy** — declarative, config-driven PII redaction
  - `RedactionPolicy` type with `keys`, `patterns`, and `fields` dimensions
  - `executor.setRedactionPolicy(policy)` — apply across all stages with one call
  - `executor.getRedactionReport()` — compliance-friendly audit trail (keys, fields, patterns — never values)
  - Exact key matching: `keys: ['ssn', 'creditCard']`
  - Pattern matching: `patterns: [/password|secret|token/i]` — auto-redacts any matching key
  - Field-level scrubbing: `fields: { patient: ['ssn', 'dob'] }` — redacts specific fields within objects
  - Dot-notation nested paths: `fields: { patient: ['address.zip'] }` — scrubs deeply nested fields
  - Global regex `lastIndex` safety — stateful patterns handled correctly
  - Policy is additive with existing manual `setValue(..., true)` approach
- `RedactionPolicy` and `RedactionReport` types exported from `footprintjs`
- **Optional `scopeFactory`** — `FlowChartExecutor` now defaults to `ScopeFacade` when no scope factory is provided
  - Before: `new FlowChartExecutor(chart, (ctx, name) => new ScopeFacade(ctx, name))`
  - After: `new FlowChartExecutor(chart)` — zero boilerplate for the common case
  - Custom factories (with recorders, typed scopes, Zod validation) still work as before

## [0.5.0] - 2026-03-09

### Added
- **PII Redaction** — `setValue(key, value, true)` now protects ALL recorders, not just EventLog
  - `_redactedKeys` tracking on ScopeFacade — scrubs values before dispatching to any recorder
  - `redacted?: boolean` field on `ReadEvent` and `WriteEvent` types for custom recorder logic
  - `useSharedRedactedKeys(set)` / `getRedactedKeys()` — share redaction state across stages
  - Cross-stage redaction auto-wired in `FlowChartExecutor` — once a key is redacted, all subsequent stages' recorders see `[REDACTED]`
  - `updateValue()` on a redacted key stays redacted; `deleteValue()` clears redaction status
- Redaction section in [scope guide](docs/guides/scope.md#redaction-pii-protection)
- PII Redaction row in README Key Features table

### Changed
- Release script now validates CHANGELOG entry exists, extracts notes, and creates GitHub releases automatically
- CHANGELOG backfilled for all historical versions (v0.2.1, v0.2.2)
- All GitHub release notes updated to match CHANGELOG format
- Branch protection enabled on `main` (requires PR with 1 approval)

## [0.4.0] - 2026-03-08

### Added
- **FlowRecorder system** — pluggable observers for control flow narrative
  - 7 built-in strategies: Windowed, Silent, Adaptive, Progressive, Milestone, RLE, Separate
  - `attachFlowRecorder(recorder)` / `detachFlowRecorder(id)` on FlowChartExecutor
  - Custom recorder support via `NarrativeFlowRecorder` base class
- Guides for scope, execution control, error handling, flow recorders, contracts
- Pre-push hook to run tests with coverage

### Fixed
- Use double cast in FlowRecorderDispatcher for TS strict mode
- Fix flaky `__proto__` property test

### Changed
- README repositioned as a code pattern, not a pipeline builder

## [0.3.0] - 2026-03-08

### Added
- **Contract layer** (`src/lib/contract/`) — standalone library for defining I/O boundaries on flowcharts
  - `defineContract(chart, options)` — create a typed contract with input/output schemas
  - `normalizeSchema(input)` — convert Zod or raw JSON Schema to normalized JSON Schema
  - `zodToJsonSchema(zodSchema)` — Zod v4-compatible converter (v3 also supported)
  - `generateOpenAPI(contract, options)` — generate OpenAPI 3.1 specs from a contract
- Builder schema methods: `setInputSchema()`, `setOutputSchema()`, `setOutputMapper()`
- `FlowChart` type now carries `inputSchema`, `outputSchema`, `outputMapper` fields
- Public exports for all contract types and functions from `footprintjs`

## [0.2.3] - 2026-03-07

### Fixed
- Flaky property-based test (`recorder-never-breaks-execution`) using JSON.stringify comparison

### Changed
- README: added quick-start snippet, comparison table, playground/samples links
- Removed `displayName` — `name` IS the display name, `id` is optional

## [0.2.2] - 2026-03-07

### Fixed
- README corrections to match actual project structure

### Changed
- Clarified documentation for return values in dynamic stages

## [0.2.1] - 2026-03-06

### Removed
- Deprecated `addDecider` method (use `addDeciderFunction` exclusively)

### Changed
- Clarified that return values are only needed for dynamic stages (deciders/selectors)

## [0.2.0] - 2026-03-06

### Added
- Causal trace narrative generation (NarrativeRecorder + ControlFlowNarrativeGenerator + CombinedNarrativeBuilder)
- Auto-generated `chart.description` for LLM tool selection
- `ScopeFacade` as the primary scope interface (replaces BaseState)
- Scope protection via Proxy (blocks direct property assignment)
- Pluggable recorder system (DebugRecorder, MetricRecorder, NarrativeRecorder)
- Zod-based scope validation (`defineScopeFromZod`)
- Enriched snapshots for single-pass debug capture
- Subflow composition (fork, linear, branch mounting)
- Loop support via `loopTo()`
- Streaming stages for LLM token emission
- Stage descriptions for build-time metadata

### Changed
- Architecture reorganized into six independent libraries (memory, builder, scope, engine, runner, contract)
- Moved `zod` to optional peer dependency

### Removed
- Legacy `BaseState`, `Pipeline`, `PipelineRuntime`, `GlobalStore`, `WriteBuffer` classes
- Old `src/core/`, `src/internal/`, `src/scope/`, `src/utils/` directories

## [0.1.0] - 2024-01-01

### Added
- Initial release with FlowChartBuilder, FlowChartExecutor, and core pipeline execution
