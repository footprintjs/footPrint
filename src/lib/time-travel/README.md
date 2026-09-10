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
never reshapes a snapshot to ask a question. The rows may be typed
`readonly unknown[]` (a stored recording — see [gap 5](#5-a-stored-recording-needs-no-cast)
below); they are narrowed per bundle where the fold reads them. `FoldSource` has
the same all-optional shape as `TimeTravelSource`, so a stored-recording type
with `commitLog?: readonly unknown[]` drives `stateAt` and `timeTravel` alike
— an absent log folds to the base and reports `throughCommitIdx: -1`.
`commitIdx` is an ARRAY index, inclusive; `-1` folds nothing and returns the
base; past the end clamps, and `throughCommitIdx` reports where the fold
actually stopped.

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
`options.strategy` chooses how stops are derived. An ARRAY of snapshots is a
chain — a pause and its resume read as one axis (see
[gap 4](#4-a-pause-and-its-resume-read-as-one-axis) below).

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
  began with". On a FILTERING strategy's axis `'start'` means more than that and
  says so with `prologue: true` — see [gap 2](#2-what-start-folds-on-a-filtering-axis).
- An **empty log yields no stops at all**, and every move then refuses with
  `'empty'`.
- **The shape is a contract.** Non-empty log ⇒ `[start, …stages, end]`; empty
  log ⇒ `[]`. `splitAxis` reads it so a composer never guards it by hand — see
  [gap 3](#3-the-start-stages-end-shape-is-stated-once).

### `TimeTravelStrategy` — the seam

footprintjs ships one stop grammar of its own — `commitStops`, one stop per
executed stage, the only grammar the substrate itself knows — and, since
9.21.0, one reader over the names a chart DECLARED: `tagStops` (see
"Declared vs derived tags" below). A consumer with a richer vocabulary —
milestones, turns, tool calls — supplies its own and gets the same cursor over
it.

```ts
import { commitStops, filterStops, timeTravel } from 'footprintjs/trace';
import type { TimeTravelStrategy } from 'footprintjs/trace';

const milestonesOnly: TimeTravelStrategy = {
  stopsFor: (log, tree) =>
    filterStops(commitStops(log, tree), (stop) => stop.stageId.startsWith('milestone-')),
};

timeTravel(executor.getSnapshot(), { strategy: milestonesOnly });
```

A strategy is inherited by `drill()`, so a subflow's axis follows the same
grammar as its parent's. `TimeTravelStrategy<TMeta>` is generic over the
strategy's OWN vocabulary — what it puts on `Stop.meta` — and the cursor it
drives is `TimeTravel<TMeta>`; the bare forms default to `unknown`, so every
9.17.0 strategy still compiles unchanged.

## What composing consumers hit (9.18.0)

Two consumers built on the cursor in the same week — one with a FILTERING
strategy (keep the stages its domain classifies), one mapping its own position
list into stops — and each hit the same five edges. Their reports are the
specification of everything below. All of it is additive: a 9.17.0 consumer
compiles and behaves identically (`test/lib/time-travel/backcompat.test.ts`
pins that with a 9.17.0-shaped strategy, unchanged, asserted stop for stop
against the composed one).

### 1. A strategy's own vocabulary rides on the stop — `Stop.meta`

**Why.** `Stop.kind` is the PORT's vocabulary: the four positions the substrate
knows (`'commit' | 'mount' | 'start' | 'end'`). A domain strategy classifies
stages in its own terms — a turn, a tool call, a beat — and had nowhere to put
that, so the answer travelled by RE-DERIVING it from `runtimeStageId` at every
read: a second run of the classifier that just ran, and a second chance to
disagree with it.

`Stop<TMeta>` now carries `meta?: TMeta`. The port assigns it no meaning: it
never reads, validates or branches on it, and passes it through `timeTravel`,
`jumpTo`, `drill` and marks **by reference** — never cloned, never frozen. The
stop holds the very object the strategy put there, so a mutation through one
holder is visible to every other holder. It is absent (not `null`) on every
stop `commitStops` produces, and `filterStops` never inherits it: a `true`
decision over an axis that already carries another strategy's `meta` keeps the
stop and drops that meta — only the decision's own `meta` rides on a
`Stop<TMeta>`.

```ts
import { commitStops, filterStops, timeTravel } from 'footprintjs/trace';
import type { TimeTravelStrategy } from 'footprintjs/trace';

interface Beat { kind: 'turn' | 'tool'; title: string }
declare function beatFor(runtimeStageId: string): Beat | null;

const beatStops: TimeTravelStrategy<Beat> = {
  stopsFor: (log, tree) =>
    filterStops<Beat>(commitStops(log, tree), (stop) => {
      const beat = beatFor(stop.runtimeStageId);
      return beat ? { label: beat.title, meta: beat } : null;   // null drops the stage
    }),
};

const beatCursor = timeTravel(executor.getSnapshot(), { strategy: beatStops });
beatCursor.at()?.meta?.kind;   // 'turn' — the strategy's answer, not a second derivation
```

### 2. What `'start'` folds on a FILTERING axis

**Why.** The docs said `'start'` is the fold BASE — "the state before the first
stage ran, plus any id-less leading commit". A strategy that FILTERS cannot
honour that and also partition the log: the commits before its first surviving
stop have to fold somewhere, and `'start'` is the only place. Measured by the
consumer: `commitStops`' start folds `-1..-1` and 0 keys; the milestone axis's
start folds `-1..0` and 32 keys, `userMessage` among them. Any renderer keying
on `kind === 'start'` to mean "the run's raw base" was wrong on every derived
axis.

**The decision: (a), a flag — not a fifth kind.** `StopKind` is not widened; a
new member would break every consumer with an exhaustive `switch` over it — a
compile error handed to readers who did nothing wrong. Instead `StopKind`'s
docs now state both meanings precisely, and `Stop.prologue?: true` says which
one a given start is: present when the start folds stages this axis does not
show, absent when it is the raw base. `filterStops` sets it; a hand-written
strategy that absorbs stages into its start should too. A reader that means
"before anything ran" checks `kind === 'start' && !stop.prologue`.

```ts
import { stateAt, timeTravel } from 'footprintjs/trace';

const snapshot = executor.getSnapshot();
const beats = timeTravel(snapshot, { strategy: beatStops });
const start = beats.stops[0];
start.prologue;                                  // true — seed + prepare folded in here
start.lastCommitIdx;                             // 1
beats.stateAt(start).state;                      // === stateAt(snapshot, 1).state — what the first beat READ
timeTravel(snapshot).stops[0].prologue;          // undefined — the shipped axis's start is the raw base
```

Run `examples/post-execution/time-travel/03-compose-a-strategy.ts`: the
per-stage start has 0 keys; the beat axis's start has 3 (`tenant`, `needle`,
`prepared`) and `prologue: true`.

### 3. The `[start, …stages, end]` shape is stated once

**Why.** `commitStops` returns a bare `Stop[]`, so the shape every composing
strategy relies on was not pinned. Each composer defended it with its own
runtime kind check and a mocked-substrate test — one invariant, discovered in
every repo.

The invariant is now documented on `commitStops` (non-empty log ⇒ `'start'`
first, `'end'` last, one stop per executed stage between them in execution
order; empty log ⇒ `[]`), pinned by tests on an empty log, a one-stage log, a
log with a mount and a fork, and READ by `splitAxis`, which returns
`{ ok: true, start, stages, end }` or `{ ok: false, reason: 'empty' | 'not-bookended', kinds }`.
The two refusals are different facts: `'empty'` means the run committed
nothing; `'not-bookended'` means a strategy broke the contract. `filterStops`
calls it, so most composers never see it.

```ts
import { commitStops, splitAxis } from 'footprintjs/trace';

const snapshot = executor.getSnapshot();
const axis = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
if (axis.ok === false) {
  axis.reason;                 // 'empty' | 'not-bookended' — two different facts
} else {
  axis.start.commitIdx;        // -1
  axis.stages.length;          // one per executed stage
  axis.end.lastCommitIdx;      // the last bundle in the log
}
```

### 4. A pause and its resume, read as ONE axis

**Why.** A cross-executor resume produces TWO snapshots: the resumed run has a
fresh runtime, so its `commitLog` starts again at 0 and holds only the
post-resume commits. `TimeTravel` had no way to read the second as a
continuation of the first, so a reader scrubbing a resumed run silently saw
only the second half unless the application had kept the paused snapshot and
stitched the halves itself.

`timeTravel([paused, resumed])` reads both as one axis. **The honest bit:
commit indices are RUN-LOCAL.** No global index is invented — `commitIdx` and
`lastCommitIdx` keep indexing their own source, every stop carries
`sourceIdx`, `stateAt` folds in that source (a leg with its own `initialState`
restarts the fold from it — on a resume that base IS the state at the pause),
and `FoldedState.sourceIdx` says which leg the fold ended in. Only the STEPS
run across the seam; a stop's `commitIdx..lastCommitIdx` range partitions its
own LEG and never spans the seam. `changedSince` walks a seam-crossing range
leg by leg.
`drill` looks for a mount in every leg. The strategy is called once per source
with that source's own log and tree, so a strategy never knows it is chained.

**The refusal.** A chain that is not in run order, or whose legs are not from
one lineage, is refused with a reason rather than guessed at. Exactly three
things are checked, each with its own reason:

1. **No `runtimeStageId` appears in two legs.** Ids are unique within a run, so
   a repeat is the same execution recorded twice — a same-executor resume,
   whose single snapshot already holds both halves.
2. **Each leg's first execution index is past the previous leg's last.** The
   engine never resets the counter across a resume, so a backwards chain or an
   unrelated run (which restarts at `#0`) fails here.
3. **Each leg's `initialState` deep-equals the state the legs before it fold
   to.** On a resume the fresh runtime is seeded from the checkpoint, so that
   base IS the state at the pause. This is what catches a leg from some OTHER
   lineage whose indices merely happen to be higher — a different chart's
   resume, say — which checks 1 and 2 cannot see. Paths the log was redacted
   at are excluded (the fold holds `'REDACTED'` there; the checkpoint holds
   the value).

**What check 3 needs, said out loud.** It runs only where the record allows
it: the later leg must carry an `initialState`, and the earlier legs must fold
from a real base (`basis: 'initial+log'`) with no unreadable rows. A leg
recorded before 9.17 has no `initialState`; on such a chain the check is
SKIPPED — not faked — and the chain rests on checks 1 and 2 alone. The fold
then CONTINUES across the seam (the leg rule), which is the right state for a
real resume, and every fold's `basis` still says what it stood on.

```ts
import { timeTravel } from 'footprintjs/trace';

// paused = executor A's snapshot at the pause; resumed = executor B's after resume(checkpoint)
const cursor = timeTravel([paused, resumed]);
cursor.sourceCount;                               // 2
cursor.stops.map((s) => [s.step, s.sourceIdx, s.commitIdx]);
// [[0,0,-1], [1,0,0], [2,0,1], [3,0,2], [4,1,0], [5,1,1], [6,1,1]] — steps run on, indices restart
cursor.jumpTo('finish#4');                        // found in the second leg
cursor.stateAt().sourceIdx;                       // 1

timeTravel([resumed, paused]);                    // throws: "source 1 starts at execution index 0, which is not past source 0's last (4)"
timeTravel([paused, someOtherChartsResumedLeg]);  // throws: "source 1's initialState is not the state source 0 folds to. …"
```

Run `examples/post-execution/time-travel/04-chain-a-pause-and-resume.ts` for
the measured axis: 3 + 2 bundles, 7 stops, one pair of bookends.

### 5. A stored recording needs no cast

**Why.** `TimeTravelSource.commitLog` was `readonly CommitBundle[]`, but a
recording arrives as parsed JSON and a careful consumer types its rows
`readonly unknown[]` — it will not claim a stored bundle is a `CommitBundle`.
One consumer documented the resulting cast in its README as a known wart.

`commitLog` / `history` now take `readonly unknown[]`, and `executionTree` /
`subflowResults` take `unknown`; the narrowing happens inside, per bundle,
where the fold reads one. A live snapshot is assignable exactly as before and
folds byte for byte as before (the clean path returns the same array and
allocates nothing). A row that is not a bundle becomes a GAP: it **keeps its
index** (so every `commitIdx` still addresses the same row), contributes no
state, gets no stop, and is reported in `FoldedState.skipped` as
`{ index, reason }`. One corrupt row loses that row, not the recording — and
a fold that stops short of the gap says nothing, because it lost nothing.
`isCommitBundle(row)` is exported for a consumer that wants to validate rows
itself.

```ts
import { stateAt, timeTravel } from 'footprintjs/trace';

interface StoredRecording {
  readonly commitLog: readonly unknown[];        // honest: parsed JSON
  readonly initialState?: Record<string, unknown>;
  readonly executionTree?: unknown;
}
declare const stored: StoredRecording;

const cursor = timeTravel(stored);               // no cast
stateAt(stored, 2).skipped;                      // undefined on a clean log — the 9.17.0 shape
// with row 1 replaced by `null`:
//   stops: start@-1 → collect@0 → report@2 → end@2   (report is STILL at 2)
//   skipped: [{ index: 1, reason: 'not an object (null)' }]
```

Run `examples/post-execution/time-travel/05-a-stored-recording-needs-no-cast.ts`.

## Declared vs derived tags (9.21.0)

"Filter stops by tag — is a tag commit-based or state-based?" Both exist, as
different things, and the split IS the design. Three marks end in the same
operation (`filterStops`: keep these stops, fold the rest into them) and differ
in who puts the mark and when:

| Mark | Who, when | Lives | Example |
|---|---|---|---|
| **Declared tag** | the author, at build time | the Map (`SerializedPipelineStructure.tags`) → stamped into the Trace (`CommitBundle.tags`) | `'milestone:llm-turn'` |
| **Derived tag** | the reader, at read time, from the fold or the write set | computed by a strategy; never stored | "the answer changed here" |
| **Bookmark** | the reader, at read time, by choice | on the cursor (`mark` / `marks`); beside a recording, never in it | "come back here" |

Only the first was missing from the record. Its laws:

1. **A tag is a NAME declared at build time; a value is never a tag.** There is
   no run-time `$tag()`: a runtime string could carry a value (`'user:' +
   email`) past every redaction point. Data-dependent marks are derived (a keep
   rule, below) or telemetry (`$emit`) — never the log.
2. **Absent when empty.** An untagged chart's log, snapshot, checkpoint and
   every recorder output are byte-identical to 9.20.0
   (`test/lib/engine/scenario/declared-tags-byte-identity.test.ts`, reference
   generated on the 9.20.0 tree).
3. **The tag is the fact; a derivation is the fallback.** A consumer that
   classified stops from ids reads `bundle.tags` first and derives only for
   recordings made before tags existed.
4. **Free strings in the substrate.** footprintjs owns no vocabulary; a consumer
   declares its own (`'milestone:<kind>'`). Any-of is `tagStops`'s keep rule;
   all-of, or anything richer, is a `filterStops` call away; `meta` carries the
   bundle's full array.
5. **Attribution by precedence.** Untagged stages fold into the tagged stop
   BEFORE them — what `filterStops` does. Not a per-tag flag.
6. **The Map advertises the vocabulary.** The spec node carries `tags` as-is,
   so a lens draws its legend before the run exists; the Trace shows which a
   run DID hit.

Stamped once per execution of the stage, on its FIRST bundle: retry attempts
share one stamp, a failed stage keeps its tag (the error path commits before it
rethrows), an empty commit is a tagged stop, a fork child's fan-out repeat and
a mount's exit bundle carry none, and a stage that pauses and is resumed on a
fresh executor is two tagged stops on a chained axis — it ran twice.

**Example 1 — declared, scrubbed by `tagStops`.**

```ts
import { flowChart } from 'footprintjs';
import { tagStops, timeTravel } from 'footprintjs/trace';

interface State { messages?: string[]; answer?: string; route?: string; [key: string]: unknown }

const chart = flowChart<State>('Seed', (s) => { s.messages = ['hi']; }, 'seed')
  .addFunction('Call model', (s) => { s.answer = ' draft '; }, 'call-llm')
  .tag('milestone:llm-turn')
  .addFunction('Trim', (s) => { s.answer = s.answer?.trim(); }, 'trim')
  .addFunction('Route', (s) => { s.route = 'done'; }, 'route')
  .tag('milestone:decision', 'audit')
  .build();

chart.buildTimeStructure.next?.tags;   // ['milestone:llm-turn'] — the Map, before any run

// …run it on an executor, keep the snapshot; later, anywhere:
const cursor = timeTravel(executor.getSnapshot(), { strategy: tagStops(['milestone:llm-turn', 'audit']) });
cursor.stops.map((s) => s.label);   // ['Run start', 'Call model', 'Route', 'Run end']
cursor.stops[1].meta;               // ['milestone:llm-turn']  — the bundle's whole array
cursor.stops[0].prologue;           // true — 'seed' ran before the first tagged stage
cursor.stateAt(cursor.stops[1]);    // the fold through 'trim' too: it belongs to the turn before it
```

**Example 2 — the same axis DERIVED, by a write-set predicate.** No new API:
a keep rule over the bundle's own trace, computed at read time and never
stored. This is what "the current skill changed here" looks like — and it is
the fallback for a recording made before its chart declared tags.

```ts
import { commitStops, filterStops, timeTravel } from 'footprintjs/trace';
import type { TimeTravelStrategy } from 'footprintjs/trace';

/** A stop wherever `answer` or `route` was written — derived from the write set. */
const changedAnswerOrRoute: TimeTravelStrategy<readonly string[]> = {
  stopsFor: (log, tree) =>
    filterStops<readonly string[]>(commitStops(log, tree), (stop) => {
      const written = log[stop.commitIdx].trace.map((entry) => entry.path);
      const hit = written.filter((path) => path === 'answer' || path === 'route');
      return hit.length > 0 ? { meta: hit } : null;   // null drops the stage
    }),
};

const derived = timeTravel(executor.getSnapshot(), { strategy: changedAnswerOrRoute });
derived.stops.map((s) => s.label);   // ['Run start', 'Call model', 'Trim', 'Route', 'Run end']
derived.stops[1].meta;               // ['answer'] — what changed, not what was declared
```

The two axes differ exactly where a declaration and a derivation differ: the
derived one stops at `Trim` (it wrote `answer`) and knows nothing about
`'audit'`; the declared one stops where the author said a turn was, and
`Trim` folds into it. Neither is wrong. A reader that wants the fold itself as
the predicate — "keep the stop where `stateAt` shows a new skill" — writes the
same shape over `stateAt(source, stop.lastCommitIdx)`, and pays one fold per
candidate stop for it (measured: 323 ms per fold on 1,719 commits in
agentfootprint); that cost is why a derivation is the fallback and the
declaration is the fact.

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
- `examples/post-execution/time-travel/03-compose-a-strategy.ts` — `filterStops`, `Stop.meta`, `Stop.prologue`, `splitAxis`
- `examples/post-execution/time-travel/04-chain-a-pause-and-resume.ts` — a chained cursor and its refusals
- `examples/post-execution/time-travel/05-a-stored-recording-needs-no-cast.ts` — `unknown[]` rows, gaps by index
