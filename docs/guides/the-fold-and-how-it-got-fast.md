# The fold, and how it got fast

A guide for someone who thinks in data structures and complexity. It tells one story in
order: the base algorithm, then each optimisation, what each traded, what each measured,
and what was refused. Every number here comes from a checked-in bench or a pinned test;
nothing is estimated. Where a step lives in a different repo, it says so.

The two folders this spans: `src/lib/memory/` (the commit log and its replay) and
`src/lib/time-travel/` (the reader's cursor). The per-key memo lives in agentfootprint.

## 0. The data structure

An **append-only log** of commit bundles, one per executed stage. A bundle carries:

- `idx` — its position in THIS log (a subflow's log numbers from 0 again);
- `runtimeStageId` — the globally unique address of the stage that produced it;
- `trace[]` — one row per write: a path, a verb (`set | merge | append | delete`), and the
  keys tracked-read before that write;
- a payload — the values, encoded `full` (final values) or `delta` (net change).

The **state at a stop** is a left fold: start from `initialState`, apply every bundle up to
the stop's `lastCommitIdx`, in order. There is no undo anywhere. Travelling backwards is the
same operation as travelling forwards: replay from the base, stop earlier.

Why that law: nothing is ever un-applied, so every state a reader can reach is a state the
run genuinely had. An undo-based cursor can drift; this one cannot.

## 1. The base algorithm and its cost

```
stateAt(stop):
    state = clone(initialState)
    for i in 0 .. stop.lastCommitIdx:
        state = applySmartMerge(state, log[i])     # clones the base once per bundle
    return state
```

**Time:** O(commits × state size) — the clone per bundle is the term that hurts.
**Memory:** nothing beyond the log itself. No snapshots are kept.
**Measured** (agentfootprint, a 100-turn agent, 1,719 commits): **323 ms** for one fold,
**11.7 s** to fold once per epoch (101 epochs). A per-epoch reader cannot pay that.

## 2. What was refused: periodic full snapshots

The textbook fix is to keep a full state every k commits and fold only from the nearest one
(event-sourcing "checkpointing"). It trades memory for time. It was refused for two reasons:
the cost was never the number of commits, it was the clone per bundle, which a checkpoint
still pays for every bundle after it; and it would hold whole states in memory in proportion
to run length, which is the compromise the family did not want to make. Every step below
keeps memory proportional to what was ASKED, never to the run.

## 3. Optimisation: fold one key, not the state (agentfootprint `keyedFold`)

A consumer that asks "what was `history` at epoch k" does not need the whole state.

```
valueAt(key, idx):
    touches = index[key]                          # built once: key → [rows touching it]
    last    = binarySearch(touches, at <= idx)
    anchor  = latest touch ≤ last whose verb fully determines the key (set | delete)
    value   = anchor ? undefined : base[key]      # no anchor ⇒ the base IS the start
    for i in anchor .. last: value = applySmartMerge(value, touches[i])
```

**Time:** O(rows touching that key), not O(commits × state).
**Memory:** one value per key asked, plus the index (one small record per trace row).
**Law kept:** the verbs are applied by the engine's own function — no second definition
of what a merge means — and the result is pinned equal to the real fold on real runs,
including a resumed one and a merge with no anchor (the one shape that needs the base).
**Measured:** the per-epoch scrub from 11.7 s to **78 ms**.

### 3b. The forward cursor

An agent's `history` is set once and appended every turn, so a query at turn k replays k
appends, and a scrub that asks once per epoch is O(E²). The memo remembers the furthest
position reached per key and resumes from it; a backward or out-of-order query simply falls
back to the anchor. **Measured:** a 96-turn scrub from 201 ms to **40 ms**. Values are frozen
before anything else can hold them, because the cursor keeps that very object.

## 4. Optimisation: skip the superseded set (footprintjs 9.22.1)

After 9.22.0 made nested array writes truthful, a stage writing N elements of one array
records N whole-array `set` rows on ONE path. Replaying them cloned the array N times per
fold; commit cloned it N times into the payload.

```
supersededByNextSet(rows, i):
    rows[i].verb == 'set' AND rows[i+1] exists AND rows[i+1].verb == 'set' AND same path
```

A `set` row writes a clone of the recorded value; a CONSECUTIVE `set` of the same path writes
a clone of the same recorded value over it, with nothing running in between — so the first
write is unobservable. One rule, asked in the two loops that iterate rows before any verb
switch. **Log bytes identical** (references generated on 9.22.0, both encodings, plus a
6,000-program differential fuzz).

**The trap, pinned:** the wider skip — "any earlier row on the same path" — is NOT safe.
`set list; delete list.1; set list = 0` materialises through a primitive and the second `set`
REPAIRS it; a property test found this on run 228. Consecutive-only is the law.
**Measured:** fold at 1,000 rows from 241 ms to **1 ms**; total from 1,039 ms to 586 ms.

## 5. Optimisation: clone once at commit (footprintjs 9.23.0)

Every write deep-cloned its value twice for the record — into the patch and into the
retained-writes view — though only the last write to a path can matter at commit.

The record must never alias a caller's object (committed state is immutable-after-swap).
That law stays. What moves is WHEN the copy is taken: the patch trees hold references
until commit, and the ONE place a payload leaves the buffer clones each surviving path's
final value, once.

**Time:** the two O(size) clones per write become one per surviving path per stage.
**Memory:** references held until commit, bounded by the stage's own writes — no snapshots.
**What moved, on purpose:** write an object, then mutate that same object before the stage
ends, and the record now carries the object as the stage last saw it. Before, the log kept
the write-time snapshot while the stage read the mutated one — landmine 3, a documented
defect, now closed. The honest form for a write-time snapshot is to clone before writing.
**Where the design was wrong:** a nested `merge`'s result would leak by reference into the
patch, so held ancestors are detached first; and an uncloneable value now fails at commit,
with the run still rejecting and nothing landing.

## 6. Optimisation: unwrap the element, not the array (footprintjs 9.23.0)

The array proxy ran the WHOLE rebuilt array through a JSON round-trip on every element
write, though the library's own law says only the ASSIGNED value is normalised. Now the
assigned element is unwrapped and untouched siblings pass through by reference.

**What moved, on purpose:** writing element 3 no longer alters the bytes of element 5 — a
`Date` or `Map` sitting untouched at index 0 keeps its type. In 9.23.0 the assigned element
was still normalised as before; 9.24.0 removed that last round-trip too (the scope's own
handles are recognised now — `reactive/handles.ts` — so nothing needs copying at the write),
and the trap and `$setValue` store the same bytes.

## 7. The result, on the checked-in bench (`bench/element-writes.ts`, total time)

| element writes in one stage | 9.22.1 | after §5 | 9.23.0 (§5 + §6) |
|---|---|---|---|
| 1,000 | 609 ms | 129 ms | **5.7 ms** |
| 10,000 | 61.5 s | 14.3 s | **104 ms** |

The step from 1k to 10k is 18×, not 10×: the residual is the proxy's own shallow copy per
write (≈9 µs), which only shows at ten thousand. Named, not chased. `$batchArray` remains
the bulk path (one row, one copy).

## 8. What is a dial, what is a memo, what is the law — and why

Three shapes, and every optimisation above belongs to exactly one:

- **A dial** when the trade is the operator's: `readTracking`, `writeTracking`,
  `commitValues`, `writeProvenance`. Memory against time, chosen per run, and RECORDED in the
  snapshot so a reader knows what the record can answer.
- **A memo outside the core** when nothing about bytes or semantics changes: `keyedFold`
  (§3) lives in the consumer, over the port, pinned equal to the real fold. That is the
  adapter shape.
- **The law, one owner** when the optimisation touches the verbs: §4, §5, §6. These are not
  swappable, because two implementations could disagree about the bytes — and the family's
  rule is one owner of what a merge means (no fifth verb switch).

The test for "should this be a strategy": could two implementations disagree about the
bytes? If yes, it is not a strategy. It is the law.
