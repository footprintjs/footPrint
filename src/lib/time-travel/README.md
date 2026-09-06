# time-travel/ — the reader's cursor

Time travel in footprintjs is a **reader's cursor over a finished Trace, with a
Fold at each stop**. The run is over. The commit log is what it left behind.
Nothing in this folder can move, re-run or mutate an execution — it is a
read-time query layer, exactly like `slice/`.

It exists because every consumer was writing the same commit-index arithmetic by
hand — a why-panel, a flow view, a dashboard — from the same log, and disagreeing
about the answers. This is that arithmetic, once, in the library that owns the
substrate.

Import from `footprintjs/trace`.

## The five laws

### 1. One cursor

A `TimeTravel` holds the only position. `at()` is where the reader is; every
other question is answered relative to it. `drill()` does not open a second
position on this axis — it returns a **separate cursor over a separate log**
(the subflow's own), with its own base and its own stops.

```ts
const cursor = timeTravel(executor.getSnapshot());
const inner = cursor.drill('sf-payment#7');   // its own cursor
inner?.last();                                 // moving it does not move `cursor`
```

### 2. A miss never moves

Every refusal returns a reason and leaves the cursor untouched. A panel showing
step 4 keeps showing step 4 when someone mistypes an id.

```ts
cursor.jumpTo('score-risk#4');
const move = cursor.jumpTo('typo#99');
// { moved: false, reason: 'miss', at: <the score-risk stop>, nearest: <closest> }
cursor.at()!.runtimeStageId;   // still 'score-risk#4'
```

`reason` is `'clamped'` (the move would land outside the axis, or on the stop
the cursor already stands on — when the target was out of range, `nearest`
names the end that was hit, which need not be where the cursor is), `'miss'`
(no such stop) or `'empty'` (this cursor has no stops at all — an empty log).

### 3. A fold result is detached

`stateAt` returns a deeply frozen clone that shares nothing with the engine or
with the log it was folded from — and it says how it was derived.

```ts
const { state, basis, redacted } = cursor.stateAt();
// basis: 'initial+log'  — folded from the run's real base. Complete.
// basis: 'log-only'     — no base travelled with this log; anything seeded
//                         before the run and only merged since is missing.
// redacted: true        — the log was scrubbed at write time, so this state
//                         carries 'REDACTED' where values were removed.
```

The verbs are replayed by `applySmartMerge` — the same switch the live commit
uses. There is deliberately no second implementation of the verb grammar here.

### 4. Marks live beside the log

Bookmarks are the **reader's** notes, not the run's record. They live in the
`TimeTravel` instance; nothing writes them into the commit log or the snapshot.
A mark names its stop by `runtimeStageId`, not by step number, so it survives a
change of strategy.

```ts
cursor.jumpTo('score-risk#4');
cursor.mark('where it went wrong');
cursor.first();
cursor.jumpToMark('where it went wrong');   // back at score-risk#4
cursor.marks();                              // a detached, frozen list
```

### 5. Stops are derived from the recorded log

A strategy may group, filter, label and order **what was recorded**. It may not
re-walk the execution tree to synthesize a stop for something that was never
committed — a cursor that stops where no evidence exists is telling a story, not
reading one.

## The queries

### `stateAt(source, commitIdx)` → `FoldedState`

The fold. `source` is a run snapshot (`commitLog` + `initialState`) or a subflow
subtree (`history` + `initialState`) — both spellings are accepted, so a caller
never reshapes a snapshot to ask a question. `commitIdx` is an ARRAY index,
inclusive; `-1` folds nothing and returns the base; past the end clamps, and
`throughCommitIdx` reports where the fold actually stopped.

```ts
import { stateAt } from 'footprintjs/trace';

const snapshot = executor.getSnapshot();
stateAt(snapshot, -1).state;   // before the run's first commit
stateAt(snapshot, 3).state;    // after the 4th commit

const inner = getSubtreeSnapshot(snapshot, 'sf-payment')!;
stateAt(inner, 0).state;       // the subflow's own log, its own base
```

### `commitIndexOf(log, runtimeStageId)` / `buildCommitIndex(log)`

The address translation between the id an event carries and the index every
commit-log query speaks. **First occurrence** wins: a subflow mount and a
parallel fork child each commit more than one bundle under one id, and a cursor
asks where a stage *starts*. `commitIndexOf` returns `-1` on a miss (the
`indexOf` contract its name promises); build the map once when resolving many.

```ts
import { buildCommitIndex, commitIndexOf, stateAt } from 'footprintjs/trace';

const idx = commitIndexOf(snapshot.commitLog, 'score-risk#7');
// `-1` is the miss sentinel; `idx === 0` is the run's FIRST stage, and
// `stateAt(snapshot, -1)` is exactly the state it read — the fold base.
if (idx >= 0) stateAt(snapshot, idx - 1).state;  // the state that stage read

const index = buildCommitIndex(snapshot.commitLog);  // for many lookups
```

### `timeTravel(snapshot, options?)` → `TimeTravel`

The cursor.

```ts
import { timeTravel } from 'footprintjs/trace';

const cursor = timeTravel(executor.getSnapshot());

cursor.stops;                    // the axis, in execution order
cursor.at();                     // where the reader is (starts at stop 0)
cursor.next(); cursor.prev();    // walk; clamps with a reason at both ends
cursor.first(); cursor.last();
cursor.jumpTo(4);                // by step
cursor.jumpTo('score-risk#7');   // by runtimeStageId
cursor.stateAt();                // fold at the current stop — detached
cursor.changedSince();           // keys this stop wrote (no fold at all)
cursor.changedSince(earlier);    // keys written since a named stop
cursor.drill('sf-payment#7');    // a separate cursor over the subflow's log
```

`options.marks` seeds bookmarks (e.g. restored from a saved reading session);
`options.strategy` chooses how stops are derived.

### `commitStops(log, tree?)` — the one strategy shipped

One stop per executed stage, plus `'start'` / `'end'` bookends.

- **One stop per `runtimeStageId`.** A stage can commit more than one bundle: a
  subflow mount commits its output-mapping bundle and then its mount-exit
  bundle; a fork child is committed by the fan-out and again by the stage
  funnel, and siblings interleave. Every repeat after the first is empty — the
  staging buffer was released by the first commit. The axis shows the stage
  once, which keeps `runtimeStageId → stop` one-to-one: what `jumpTo` and marks
  depend on.
- **Stops partition the log.** `commitIdx` is the stop's own first commit;
  `lastCommitIdx` runs to just before the next stop begins. Every bundle belongs
  to exactly one stop, so `stateAt(stop)` is exactly the state the next stage
  started from.
- **`'start'`** is the position before the first stage ran: the fold base, plus
  any id-less leading commit — which is how a subflow's `inputMapper` seed
  reaches the log. So on a drilled cursor, `'start'` is "the input this subflow
  began with".
- An **empty log yields no stops at all**, and every move then refuses with
  `'empty'`.

### `TimeTravelStrategy` — the seam

footprintjs ships exactly one strategy, because one stop per executed stage is
the only stop grammar the substrate itself knows. A consumer with a richer
vocabulary — milestones, turns, tool calls — supplies its own and gets the same
cursor over it.

```ts
import { commitStops, timeTravel } from 'footprintjs/trace';
import type { TimeTravelStrategy } from 'footprintjs/trace';

const milestonesOnly: TimeTravelStrategy = {
  stopsFor: (log, tree) =>
    commitStops(log, tree)
      .filter((stop) => stop.kind !== 'commit' || stop.stageId.startsWith('milestone-'))
      .map((stop, step) => ({ ...stop, step })),   // steps stay 0..n-1
};

timeTravel(executor.getSnapshot(), { strategy: milestonesOnly });
```

A strategy is inherited by `drill()`, so a subflow's axis follows the same
grammar as its parent's.

## What this is NOT

- **Not the Walker.** The engine's traversal is the walk; this is a reader. No
  API here resumes, re-runs or edits a run. To continue an execution from a
  prior point, use pause/resume (`M2` in `.claude/rules/backtracking.md`).
- **Not a second cursor.** One position per `TimeTravel`. Drilling makes a new
  cursor over a new log; it never splits this one.
- **Not a state-rollback.** Folding produces a detached *view* of history.
  footprintjs has no rollback anywhere, by design.

## DAG position

`memory ← time-travel`, plus `engine/runtimeStageId` — the zero-dependency id
grammar that defines what a `runtimeStageId` means, and therefore the one piece
of `engine/` a reader of ids cannot honestly re-implement. Recorders, traversal
and runner are never imported here: the snapshot arrives as a plain structural
shape, so a stored JSON trace works exactly like a live `getSnapshot()`.

## Substrate this rests on

- `RuntimeSnapshot.initialState` — the commit log's fold base, frozen and
  detached. Bundles are diffs; the base is the other half.
- `SubflowResult.treeContext.initialState` — the same for a subflow's own log,
  surfaced as `getSubtreeSnapshot(...).initialState`.
- `getSnapshot().commitLog` is a **detached, frozen** copy of the engine's live
  log. A snapshot is a fold result: it does not keep changing under its holder.
- `initialState` is the run's RAW seed — `initialContext` merged with
  `defaultValuesForContext` — and no redaction policy ever touched it: a policy
  scrubs stage WRITES at the scope facade, and nothing wrote the base. So
  `getSnapshot({ redact: true })` **omits it**, and a fold of a redacted
  snapshot reports `basis: 'log-only'`: anything seeded before the run and only
  merged since is missing, and the result says so. On an unredacted snapshot
  the base is served and the basis is `'initial+log'`; stage writes are scrubbed
  at record time either way, so `stateAt` reports `redacted: true` and names the
  paths whenever the folded prefix carried any. A fold is exactly as honest as
  the snapshot it folds — no more, and no less.

## Examples

- `examples/post-execution/time-travel/01-a-readers-cursor.ts`
- `examples/post-execution/time-travel/02-fold-a-stored-run.ts`
