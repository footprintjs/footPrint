# The record contract

Time travel, the fold and the lenses read a finished run's **record**. They
never call the executor. So the record's shape is an interface: write it,
from any runtime, and you get the cursor, the fold, the stops, and the
Lens. This page is that interface, as footprintjs 9.27.0 reads it. The
tests that enforce every line are named at the bottom.

## What a record is

A record is a plain JSON value with these fields. Only `commitLog` is
required.

| Field | Type | Required | What it is |
|---|---|---|---|
| `commitLog` | array of bundles | yes | One bundle per executed stage, in execution order. Position is the commit index. |
| `initialState` | object | no | The state the run started from — the **frozen base** every fold starts at. Absent: the fold starts from `{}` and reports `basis: 'log-only'`. |
| `executionTree` | tree of stages | no | The run tree, stages linked by `next` and `children`. Needed only for stop kinds and grouping; the commit axis works without it. |
| `history` | array | no | An older name for `commitLog`; read when `commitLog` is absent. |

Everything else a footprintjs snapshot carries (`sharedState`,
`subflowResults`, `recorders`) is ignored by the reader.

## A bundle

One bundle is one stage's commit: what it wrote, as the log spells it.

| Field | Type | Required | Rule |
|---|---|---|---|
| `runtimeStageId` | string | yes | The stage's address: `[subflowPath/]stageId#executionIndex`. Unique in the run. The reader splits on the LAST `#` and `/`. `~` is reserved. |
| `trace` | array of rows | yes | The writes, in order. Each row is `{ path, verb, readKeys? }`. |
| `overwrite` | object | no | Values for `set` and `append` rows, keyed by path. Plain object. |
| `updates` | object | no | Values for `merge` rows, keyed by path. Plain object. |
| `redactedPaths` | array of strings | no | Paths a redaction policy cleared; the fold reports them. |
| `tags` | array of strings | no | Names declared for the stage at build time. Never a value. |
| `idx`, `stage`, `stageId` | | no | Advisory. The reader derives the commit index from position. |

A trace row's `verb` is one of exactly four: `set`, `merge`, `append`,
`delete`. `path` is a top-level key or a nested path; a nested path uses
the record's own separator (U+001F between segments), and a foreign
producer that writes only top-level keys never needs it.

## The laws a producer keeps

1. **The base is frozen.** `initialState` is never rewritten. Everything
   after it is a bundle.
2. **The log is append-only.** Bundles are added at the end, never edited,
   never reordered. The commit index of a bundle is its position.
3. **One bundle per executed stage.** A stage that wrote nothing still has
   a bundle, with an empty `trace`; it is a stop the cursor can stand on.
4. **Four verbs, no fifth.** `set` replaces, `merge` deep-merges an object,
   `append` extends an array, `delete` removes. Anything else is not a
   delta the reader can fold.
5. **Addresses are unique and follow the format.** Execution index rises
   monotonically across the run and is never reset, including across a
   pause and resume.
6. **Tags are names, declared up front.** A tag is a string on a bundle,
   decided when the run was built, not a value computed while it ran.

## What the reader promises

- **The fold.** `stateAt(record, commitIdx)` replays the base plus every
  bundle up to and including that index, and hands back a frozen state with
  its **basis** (`'initial+log'` or `'log-only'`), the redacted paths, and
  the bundles it could not read as `skipped`. The record is never touched.
- **Stops.** `timeTravel(record)` derives stops from the log: a `start`,
  one `commit` stop per bundle, an `end`. `tagStops(names)` is a strategy
  handed as `{ strategy }` that keeps only the bundles carrying any of the
  names. With an `executionTree`, stops also carry the stage's kind.
- **Gaps, not refusals.** A bundle the reader cannot read becomes a gap
  `{ index, reason }` in `skipped`. The rest of the record still folds. The
  reasons, exactly:
  - `not an object (null | array | <type>)`
  - `runtimeStageId is missing | a <type>, not a string`
  - `trace is missing | a <type>, not an array`
  - `updates is not a plain object` · `overwrite is not a plain object`
  - `trace[i].verb is missing | "<verb>", not set | merge | append | delete`
- **Same answer, any producer.** A record footprintjs wrote and the same
  record written by hand fold to the same state. The example below is that
  record.

## What is not in this contract

- The milestone axis (`Iteration`, `LLM turn`, `Route`, `Answer`) is
  agentfootprint's tag vocabulary over this record, not part of it.
- The served receipt, injections and the story trace are agentfootprint's
  own keys in the state; the fold carries them like any key.
- A record version field. The contract is versioned by the footprintjs
  version that reads it, named at the top of this page.

## Bring your own record

```ts
import { stateAt, tagStops, timeTravel } from 'footprintjs/trace';

const record = {
  initialState: { count: 0, items: [] },
  commitLog: [
    { runtimeStageId: 'seed#0',   trace: [{ path: 'count', verb: 'set' }],    overwrite: { count: 1 } },
    { runtimeStageId: 'grow#1',   trace: [{ path: 'items', verb: 'append' }], overwrite: { items: [10] }, tags: ['milestone:step'] },
    { runtimeStageId: 'forget#2', trace: [{ path: 'count', verb: 'delete' }], overwrite: { count: undefined } },
  ],
};

const tt = timeTravel(record);              // start, three commit stops, end
stateAt(record, 1).state;                   // { count: 1, items: [10] }
stateAt(record, 2).state;                   // { items: [10] }
timeTravel(record, { strategy: tagStops(['milestone:step']) }).stops; // start, the tagged stop, end
```

The full example, run as an integration test, is
`examples/post-execution/time-travel/06-bring-your-own-record.ts`.

## Enforced by

- `test/lib/time-travel/record-contract.test.ts` — the hand-built record
  folds through all four verbs; every gap reason above, verbatim; an
  unknown verb is a gap, not a merge.
- `test/lib/time-travel/stored-recording.test.ts` — a stored record drives
  the cursor with no cast.
- `test/lib/time-travel/fold-memo.test.ts` — the fold never touches the
  record, and stepping equals a fresh fold at every stop.
