# Clone once at commit — the element-write loop goes linear (design, 2026-09-11)

**Status:** IMPLEMENTED in 9.23.0. Approved by the owner 2026-09-11 ("ok go ahead") after the
9.22.0 performance review. Two claims below were wrong and the code won (marked CORRECTED);
and a SECOND site the page did not name — the array proxy's whole-array JSON round-trip per
element write — was the other half of the quadratic and was fixed in the same minor with its
own pinned moved behaviour (an untouched sibling element keeps its bytes).

## The finding (measured, checked-in bench `bench/element-writes.ts`)

A stage that writes N elements of one array through the scope proxy is O(N²). After 9.22.1
removed the redundant clones at commit and in replay, what remains is the stage BODY:
1,000 writes = 586 ms, 10,000 = 59 s. The CPU profile at N = 1,000 puts ~440 µs of every
write in two `structuredClone`s of a value the NEXT write overwrites:

| clone | where | why it exists today |
|---|---|---|
| `structuredClone(value)` into `overwritePatch` | `TransactionBuffer` · `set` | the PATCH must not alias the caller's object |
| `retainedForm(...)` into `_stageWrites` | `StageContext` · `trackWrite` | the execution tree's `stageWrites` view must not alias it either |

Both are correct in intent: the caller may mutate its own object after the write, and the
record must not see that. Both are wasteful in timing: the clone is taken per WRITE, but a
patch only needs to be final at COMMIT, and the last write to a path wins.

## The law this page keeps

**The record never aliases a caller's object.** Committed state is immutable-after-swap,
and a patch or a retained write must be a copy the caller cannot reach. That law stays.
What changes is WHEN the copy is taken: at commit (once per surviving path) instead of at
every write (once per write).

## The one behaviour that moves — and it is landmine 3, made honest

Today, `$setValue(k, o)` followed by `o.x = 1` in the SAME stage commits the value of `o`
AS IT WAS at the write (the clone), while the stage reads back the mutated `o` from the
working copy. Log and stage disagree. CLAUDE.md names this as landmine 3 and calls it a
defect. Cloning at commit changes it: the patch would carry `o` AS IT IS at commit, which
is what the stage saw. That is the record agreeing with the stage — the law of 9.22.0
("fold === state"), not a regression.

**Decision:** clone at commit, and DOCUMENT the consequence as the closing of landmine 3's
first bite: a post-write mutation of the caller's own object now lands in the commit as
the stage read it. The second bite (a RAW handle held past the stage) is unchanged and stays
named. If a consumer relied on the old "snapshot at write time" behaviour — no known one
does; grep the family — the honest form of that intent is `$setValue(k, structuredClone(o))`.

**Refused alternative:** freezing the caller's object after the write (would throw on their
own mutation; a library must not freeze what it did not create).

## Sites (one owner each; the FOUR verb replicas untouched)

- `TransactionBuffer` · `set` / `merge` / `append` / `delete`: store the REFERENCE in the
  patch trees (they already store it in `workingCopy`); no clone here.
  CORRECTED BY THE CODE: a nested `merge`'s result would leak into `overwritePatch` by
  reference (caught by the 9.22.0 set-merge-interleaved reference), so the held ANCESTOR is
  cloned first (`heldRefs` + `detachHeldAncestors`); unreachable from the proxy, which writes
  roots. Also: an uncloneable value now throws at COMMIT, not at the write — the run still
  rejects with `DataCloneError`, none of the stage's writes land, and the pending map is
  released in `finally` so a failed run still snapshots.
- `TransactionBuffer` · `toChangeOnlyPayload` / `toDeltaPayload`: the ONE place a payload
  leaves the buffer — clone each surviving path's final value here, once. 9.22.1's per-path
  memo already sits in this loop; the clone joins it. The delta encoder's `replayFamilyVerbs`
  needs no change: it folds patch values into a fresh family value already.
- `StageContext` · `trackWrite`: retain the reference; materialise `_stageWrites` (the
  retained/summarised form) at `commit()` from the final values, once per key. The
  `writeTracking` dial semantics ('full' | 'summary' | 'off') unchanged; the summariser runs on
  the final value.
- Redaction (9.19.0 one owner): `stageWrite` asks the rule BEFORE staging, as today; the
  commit-time clone sees only what the rule allowed in. No new scrub point.
- `discardStaged` (retry, 9.15.0): drops references — trivially correct, nothing to un-clone.

## What must be proven (red before where it can be)

1. **Byte-identity where the caller does not mutate**: the existing references
   (`declared-tags-byte-identity`, `redaction-no-policy-byte-identity`, `repeated-path-…`)
   pass unchanged in both encodings — no log byte moves for any program that does not
   mutate its own object after a write.
2. **The moved behaviour, pinned by name**: `$setValue(k, o); o.x = 1` → the bundle carries
   `x: 1` and `stateAt` agrees with `sharedState`; the CHANGELOG example is this test.
3. **No aliasing**: after commit, mutating the caller's object does NOT change the commit
   log, the mirror, `stageWrites`, or the folded state (the law kept).
4. **Complexity**: `bench/element-writes.ts` — 1k and 10k in both encodings; the ratio
   1k→10k must be ≈10×, not ≈100×. Report the numbers; the CHANGELOG quotes the bench.
5. **The retry path**: a failed attempt's staged references are discarded and the final
   attempt commits only its own writes (`retry` scenario tests pass unchanged).
6. **Subflow seed + merge-back** and **cross-executor resume** unchanged (their scenario
   tests pass; both go through `stageWrite`).

## Docs

`src/lib/memory/README.md` design table gains the row (what/why/consequence, incl. the
landmine-3 closure); `TransactionBuffer` header states "patch trees hold references until
commit"; CLAUDE.md landmine 3 rewritten to its second bite only; reactive README's
performance paragraph updates the numbers; CHANGELOG [9.23.0] WHY + the bench table +
the one moved behaviour with its example.
