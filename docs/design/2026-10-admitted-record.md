# The admitted record — a commit folds back to what the stage read (design, 2026-10-02)

**Status:** BUILT for 9.30.0 — branch `feat/admitted-record`, packet F1a of the untangle plan (owner ruling R1: the
record keeps what the step READ BACK). Every number below comes from an instrument named beside it.

## The finding

`TransactionBuffer` keeps ONE accumulated merge delta per path (`updatePatch`) and ONE overwrite value per path
(`overwritePatch`), and a bundle replays the SAME accumulated delta at every `merge` row of that path. That is
faithful only while `deepSmartMerge` composes, and it does not compose across:

- **a hard write** — `$update('k', {x:1}); $setValue('k', {y:2}); $update('k', {z:3})` reads back `{y:2, z:3}`; the
  bundle (`overwrite {k:{y:2}}`, `updates {k:{x:1, z:3}}`, rows merge/set/merge) commits `{y:2, x:1, z:3}`. Through
  the plain typed scope: `s.k = {a:1}; s.k.b = 2; delete s.k.b; s.k.c = 3` commits the deleted `b`;
- **an `[]` clear** — `$update(list, [2]); $update(list, []); $update(list, [3])` over `[1]` reads back `[3]` and
  commits `[1, 3]`;
- **a kind change** — a scalar merge replaces a container and a nested merge builds another (seed 102938, program
  1,976: read back `{list: {x:'s'}}`, committed `{list: {list: [], x:'s'}}`);
- **an array union deduplicated by reference** — one element staged by a `set` and a `merge` reads back once and
  folds twice (`'full'`; the delta encoder's per-path replay kept the reference);
- **an in-place edit of a merged value** (C3) — the merged-in element is shared with the delta, the committed one is
  the stage's private copy, so a later stage read `[1, 5]` where the writing stage saw `[5, 5]`.

The delta encoder reproduced each of these on purpose, "for byte-parity with full mode", through two private
replicas of the verb law (`replayPathVerbs`, `replayFamilyVerbs`) — and `replayFamilyVerbs` cloned the merge delta
PER OP, which made it lie on unions even where the full mode did not (the bug `utils · replayRows` fixed for itself
in 9.29.0: "a per-row clone duplicated elements").

A fifth shape (L-1) is a DROPPED op: a nested `delete` through an absent or primitive parent leaves a container in
the working copy that the net-change filter cannot see (`undefined` vs `undefined`), so the stage reads back a
container the record never mentions. The build's property found a sixth: the same op on an ARRAY parent past its
end grows it (`delete a.0` on `[]` reads back `[undefined]`).

Nothing checked that the committed value equals what the stage last read. Reproduced through the public API on
9.29.0 in both encodings (all five shapes) before any source edit — commit `699d9f7`.

## The law

**A commit is admitted only if its bundle, replayed onto the state the stage began from, gives back the stage's
read-your-writes view at every path the stage touched — and at every container and array slot its writes made on
the way there, below the stage's address. Compact rows (a `merge` delta, an `append` tail) stay where they
provably fold back; a family of rows that does not is recorded as `set` rows of the values the stage read.**

Borrowed: MySQL `binlog_format=MIXED` — the compact form while it provably replays, rows otherwise.

"What the stage read" is its working copy — the view every read after its first write returns — compared by
`deepEqual` (an own `undefined` is a deleted key; arrays by index; key order free), as a record can hold it: a
record holds `structuredClone`s, and a value that does not survive one whole (an `Error`'s own fields are dropped)
is compared through its clone — no row could hold more. The stage's ADDRESS (`runs/<id>`
for a run-namespaced stage, nothing otherwise) is where it writes, not a value it reads: every read a stage makes is
a key below it, so a shell its writes leave there is not part of the view.

### What is verified, and what rests on construction

- **Verified** — every commit whose stage staged a `merge` or a nested op (one deeper than a key directly under its
  address): `admission.ts · lossyFamilies` replays the candidate rows onto the diff base with `utils · dryFold` (the
  one verb switch, values by reference, **no clone**), groups the TOUCHED paths into families (each under its
  shallowest staged ancestor), and compares each family root with the working copy — by value, and on the way down
  for the containers and array slots the working copy holds (`spineHeld`).
- **By construction** — a stage that staged only `set` / `delete` of keys directly under its address (the typed
  scope's writes, but for its merges): both trees receive the same value at the same path, so the rows ARE the
  read-back. No fold is paid. The property's ROOT-ONLY arm pins the argument.

## The change, per file · symbol

| File · symbol | Change |
|---|---|
| `utils · replayRows` | `detach` flag (default `true`, every existing caller): with `false` the `set` / `append` arms place the recorded value by reference and never mark it owned, the merge arm reads `updates` itself. |
| `utils · dryFold` (new, internal) | `replayRows(ownedRootOf(base), …, true, false)` — the fold for comparison only; aliases the payload; never handed out. |
| `admission.ts` (new, internal) | the check: `lossyFamilies`, `foldsBack` (the value against the read-back as a record can hold it), `touchedFamilies`, `addressDepthOf`, `spineHeld`, `slotHeld`. Pure but for the clone it keeps on a refused family for the re-encoding. |
| `deltaEncoding.ts` (new, internal) | the delta encoder's pure helpers moved out of `TransactionBuffer`: overlap families, emission order (now with the hook that places re-encoded families), append detection, the value row. |
| `TransactionBuffer · admit` | lays the rows out (either encoder), asks the check, lays them out again with the lossy families written as their read-back (`emitReadBack`). |
| `TransactionBuffer · emitReadBack` | a lossy family: one `set` row per member that changed (descendants by last touch, each with its own last read prefix), the root LAST, `overwrite` holding the root's read-back; a lone delta root keeps `append` when the read-back is its base plus a tail. Rows go at the family's last touch. |
| `TransactionBuffer · fullRowsValue` | the delta encoder's VALUES: one `dryFold` of the stage's 'full' rows over the patch trees themselves, taken the first time it is asked. Replaces `replayPathVerbs` and `replayFamilyVerbs` (deleted). |
| `TransactionBuffer · stage` | counts staged merges and nested ops (the fast path's two counters); `constructor` takes the stage's `address`. |
| `StageContext · getTransactionBuffer` | passes the address (`['runs', runId]` or `[]`). |
| `pathOps · isContainer`, `ownChild` | exported (moved from `TransactionBuffer`). |

`TransactionBuffer.ts` 1,048 → 958 lines (`admission.ts` 186, `deltaEncoding.ts` 151). Verb-switch replicas 5 → 3 (`replayRows`, `commitValueAt`,
`arrayProvenance`; the delta encoder keeps vocabulary only).

## Named changes — each pinned

| # | Change | Where it shows | Pinned by |
|---|---|---|---|
| C2 | A family whose rows do not fold back is re-encoded as `set` rows of the read-back, at its last touch | commits that merge across a hard write, an `[]` clear or a kind change, or union arrays by reference | the property; `scenario/copy-on-write-commit.test.ts` program 1,976 (both encodings) → `set list.x; set list`, `{list:{x:'s'}}`; `unit/TransactionBuffer.test.ts` |
| C3 | An in-place edit of a value at or below a path the stage wrote — set, merged or written back — is recorded (**R1**) | out-of-contract programs (the M2 family) | `copy-on-write-commit.test.ts` "M2 after a merge": `seen == [5,5]`, row `hist:set`, births `whole-value`, dev-mode warning unchanged |
| C4 | Delta mode commits the value the stage read; its values come from one fold, the two replicas deleted | delta commits that were lossy (incl. every union `replayFamilyVerbs` doubled) | `delta-replay-equivalence` (unchanged); `unit/copy-on-write.test.ts` "the family is committed as what the stage read" |
| C5 | A dropped nested op whose container (or array slot) the stage read back is recorded at its own path (L-1 closed) | a nested `delete` / `set undefined` through an absent or primitive parent, or past an array's end — `StageContext` nested ops (subflow seed and merge-back of an all-`undefined` object, `/zod`, direct use); never the typed scope, whose deletes are keys directly under the address | `unit/TransactionBuffer.test.ts` (absent parent, primitive parent, array slot, the address) |

NOT changed: every commit that already folded back keeps its bytes — in both encodings, including the key order the
replay builds (a delta `set` row's value is the fold's, not the read-back's; `unit/TransactionBuffer.test.ts`
pins `{b, a, c}` where the stage read `{b, c, a}`). Byte-identical in both encodings, not re-pinned:
`repeated-path-9.22.0`, `no-policy-9.18.1`, `no-policy-redact-view-9.19.1`, `untagged-9.20.0`,
`unit/repeated-path-skips`, `$update('k', undefined)` (an own `undefined` delta, as on 9.29.0). Cross-family row
order is preserved; a re-encoded family takes the place of its last touch.

## Decisions made in the build (the plan, corrected where the build proved it wrong)

1. **Families over touched paths, and the spine.** The plan compared family roots only; L-1 compares `undefined` with
   `undefined` there. The check walks the way down: every container the working copy holds, the fold must hold, of
   the same kind; and every array slot a step lands in (the array-growth shape the property found).
2. **The stage's address.** The plan held C5 reachable only through `StageContext.deleteValue` — but a fork child's
   `delete scope.k` IS a nested path (`runs/<child>/k`), and through an absent namespace it leaves `runs/<child>`
   in the working copy. Without the address every fork child that deleted an absent key would have gained a row
   for a container no read of it returns. With it, the plan's statement holds.
3. **Delta values from one fold, not from the read-back.** The plan had a family member store `s.after`. That
   changes the bytes of commits that DID fold back: the read-back's key order follows the stage's own merges, the
   replay's the accumulated delta (merge `{a,c}`; set `{b}`; merge `{c}`; merge `{a}` reads `{b,c,a}` and replays
   `{b,a,c}`). The values come from `dryFold` of the 'full' rows over the patch trees, so a faithful delta commit
   keeps 9.29.0's bytes and only a lying one changes.
4. **Two passes, not a splice.** `admit` lays the rows out, checks, and — only if a family lied — lays them out
   again with that family written as its read-back. Every other family's rows are produced by the same code both
   times, so they cannot drift.
5. **Clause (c) — "no admitted merge row lacks its delta" — is false as the plan stated it**, on 9.29.0 too: `merge
   c.y`, then a `merge c` that makes `c` an array, replaces the container `c.y`'s delta sat in. The replay's
   transient value is overwritten by the later ancestor row in the same bundle, which folds back, so it is admitted
   unchanged. The property's clause (c) names that one exception.
6. **Clause (b) found a reader bug outside this packet.** `commitValueAt` clones a bundle's merge delta once PER ROW;
   two merges of one key after an anchor (`s.c = []; $update(c, [{n:1}]); $update(c, [{n:2}])`) come back doubled
   where the fold dedups. The bundle is right; the reader is not. Not fixed here (F2 folds `commitValueAt` through
   the one verb law); pinned with `it.fails` in the property file, which turns red the day it agrees.
7. **How F1a keeps the 9.28.0 differentials green.** The plan left this to F1b. The differentials and the pinned
   corpus are held by a WITNESS written independently of the build's check (`copy-on-write-fixture ·
   witnessClause`): every commit on both engines is asked whether it folds back at every touched path; every build
   commit must, and the first commit at which the two logs differ must be one where 9.28.0's did not. F1b (done)
   judges each resumed pause leg on its own and tests the witness against lies told on purpose
   (`scenario/copy-on-write-witness.test.ts`); the clause stays at the FIRST differing commit of a run, because after
   it the engines hold different states, and the baseline stays 9.28.0 (reasons in the fixture header).
8. **Compared as a record can hold it** (found downstream). agentfootprint's suite on the packed build reached the
   admission 19 times, all one shape: its reliability gate stages a nested write and `scope.error = err`, an `Error`
   with a custom field. Every record holds the Error's `structuredClone`, which drops the field, so the fold could
   never equal the working copy — and re-encoding re-spelled the same clone while collapsing the stage's two
   `error:set` rows into one. `admission.ts · foldsBack` now takes the read-back's clone when the cheap compare
   refuses a root, admits the family if the fold equals it, and hands the clone to the re-encoding. For every value
   that survives a clone the two compares agree.

## Measured

| Instrument | Result |
|---|---|
| `property/record-equals-read-back.property.test.ts` | RED on 9.29.0: 19 of 22 cases (every arm but ROOT-ONLY; seeds in the file header). Green on the build: 8 arms × 1,000 programs at fixed seeds; 480,000 more at three random seeds (`ADMITTED_RUNS=20000 ADMITTED_SEED=7777 / 15554 / 23331`). |
| `property/copy-on-write-differential.property.test.ts` (`COW_DIFF_TALLY`) | programs that differ from 9.28.0, each explained by the witness: chart 5 / 150, borrowed 6 / 150, nested 183 / 400, nested @102938 896 / 2,000, write-back 71 / 200 |
| `property/copy-on-write-pause-differential.property.test.ts` (`COW_DIFF_STATS`) | 6 / 60 explained; B (paused == direct iff on 9.28.0) asked of the other 54 |
| `scenario/copy-on-write-byte-identity.test.ts` | 74 of 320 corpus entries change (chart 5, borrowed 2, nested 55, write-back 12; B2 does not) — listed, each proven by the witness every run |
| `bench/commit-clones.ts` (counts; CPU too noisy under load to quote) | identical before and after on all 42 rows: set-only `small` 5.0 / stage at N = 100 / 1k / 10k, `mirror` 6.0, `agent` 12.0, `readback` 7.0, `readback-untracked` 6.0, new `merge` 6.0, new `nested-seed` 316.0 / interval. The check adds no clone. |
| CPU of a merge-bearing stage over a large value (scratch, 9.29.0's src vs the build, interleaved, 7 rounds × 20 stages, median; load 10–47) | `$update('history', [item])` over 10k items: ~1.9–2.0× (e.g. 16.8 → 33.3 ms); over 1k: ~1.4×. A nested field write `s.cfg.x = i` into a 10k-key object: ~1.4× (76.6 → 107.6 ms); 1k: ~1.4×. The check's `deepEqual` walks the merged value — the same order as the private copy `merge` already takes (9.29.0); no clone; set-only stages never fold. |
| downstream, on the packed build (`npm install --no-save` into fresh origin/main copies; one `footprintjs` copy each) | agentfootprint 09d90c0a: 880 files / 16,713 tests passed (+75 skipped) on 9.29.0 and on the build, 0 per-test differences, 0 files written; lens 8622b8d: 2,295 / 2,295 (+8 skipped), typecheck clean, 0 differences; neo 1cd4ffe (dummy keys): 2,097 pass / 0 fail / 11 skipped / 1 todo on both, 0 differences. A probe counting re-encoded families: 19 in agentfootprint's suite on the first pack (all decision 8's `Error` shape), 0 in every consumer on the final pack. |
| full suite | 349 files; 4,585 passed + 1 expected fail (HEAD: 347 files, 4,545 + 3 skipped) |

The plan's *(proto)* figures did not survive re-measurement on HEAD 03a16d5: "3,650 tests" (the tree has 4,545 + 3
skipped) and "6.0 clones per stage" on the set-only bench (it reads 5.0; 6.0 is the `mirror` row).

## Follow-ups

- **L-2** — the prototype spelled `$update('k', undefined)` as an absent delta; this build keeps 9.29.0's own
  `undefined` delta (pinned by the corpus and the repeated-path references). Nothing to do.
- **L-3** — the one-time `resume-real-chart.property` failure seen in a prototype gate run: run at 10× (1,600
  programs per mode) on the build, green, no seed to record.
- **F1b** — DONE: the witness clause per pause leg, and the red checks (C1 put back, a byte change that lies about
  nothing) in `scenario/copy-on-write-witness.test.ts`. Not done, on purpose: the clause at every differing stage
  (a difference after the first may follow from it) and the move of the baseline alias to 9.29.0 (it also serves the
  copy-on-write pins, and at 500 programs a family 9.29.0 explains exactly the programs 9.28.0 does).
- **F2** — `commitValueAt`'s per-row delta clone (decision 6).
- **Optional C1′** — drop a staged merge delta only when a `merge` FOLLOWS the hard write; not needed for the law.
- **The check's CPU on large merged values** (measured above). A sound way to skip it for the most common shape: a
  family that is ONE `merge` at its root, that survived, and under whose root key no read after the first write
  handed out a reference (`TransactionBuffer · get` would record the root keys it served) folds back by
  construction — the merge ran on a fresh, unexposed private copy, and the fold merges a clone of the same delta
  into the base it was copied from. Not built here: it adds a by-construction class that deserves its own review.
- **Named, not handled** — a NUMERIC path segment through an absent parent makes an array in the working copy
  (`nativeSet` picks `[]` for a number), while the log's DELIM-joined paths are strings and the replay makes an
  object. Only a caller driving `TransactionBuffer` directly can stage one (`StageContext` passes string segments);
  the check flags such a family, and its re-encoded rows still replay as an object.

## Instruments (where every number came from)

- the reproduction through the public API, before any edit: commit `699d9f7`'s message;
- `test/lib/memory/property/record-equals-read-back.property.test.ts` (`ADMITTED_RUNS`, `ADMITTED_SEED`);
- `test/lib/memory/property/copy-on-write-fixture.ts · witnessClause` and the differentials that use it
  (`COW_DIFF_TALLY=<file>`, `COW_DIFF_STATS=<file>`);
- `test/lib/memory/scenario/copy-on-write-byte-identity.test.ts` (`ADMITTED`);
- `bench/commit-clones.ts` (two rows added: `merge`, `nested-seed`).
