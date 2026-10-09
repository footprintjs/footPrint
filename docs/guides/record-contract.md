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
| `executionTree` | `ExecutionTree` (9.48.0) | no | The run tree, stages linked by `next` and `children`. The readers read `id`, `runtimeStageId`, `subflowId`, the keys of `stageReads`, `next` and `children` — all optional; a live run's `StageSnapshot` tree is one. Needed only for stop kinds, grouping and read keys; the commit axis works without it. |
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

## Writing a record

A record can be written by hand, as above, or through `footprintjs/write`:
the record layer the engine itself writes with. There is no wrapper, so a
record written this way comes from the same code — and the same bytes — as one
a flowchart wrote, and it keeps the laws above by construction:

| Class | What it is | The laws it keeps |
|---|---|---|
| `SharedMemory` | The heap: live state, one generation per commit | — |
| `EventLog` | The log: the base (a copy of the state it is given) and the bundles, each frozen as it is recorded | 1, 2 |
| `RecordFrame` | One step: its reads (`read`, and `noteRead` to name a read on the rows), its writes (`write(path, value, verb, scrub?)` at `at(path, key)`), and one `commit` | 3, 4 |

- **One step, one frame, one bundle.** `commit(stampOf)` records the bundle
  the step staged — the empty bundle when it staged nothing — named by the
  stamp: `stage`, `stageId`, `runtimeStageId`, and optionally `tags` —
  names you declare up front (law 6), never a value the step computed.
- **Addresses are yours to keep unique** (law 5): build them with
  `buildRuntimeStageId` and one `createExecutionCounter` from
  `footprintjs/trace`, never reset.
- **The two dials** are the frame's encoding (`useEncoding`):
  `commitValues: 'full' | 'delta'` (a grown array is an `append` of its tail
  under `'delta'`) and `writeProvenance: 'off' | 'reads-prefix'` (each row
  names the reads noted before it, `readKeys`).
- **A secret** is written with the bytes of a redaction verdict: the scrub
  `{ whole: true }` puts `'REDACTED'` in the log at the path, and
  `{ fields: [...] }` at each field inside the value; the heap keeps the value.
- **Promised:** the writing contract — the members above, one frame per step —
  and the bytes they write follow the record fixtures' re-pin policy
  (`test/fixtures/README.md`): a refactor never moves a byte. The classes also
  carry engine-facing members that are not part of it: `SharedMemory ·
  setValue` / `updateValue` (they write the heap with no bundle), `EventLog ·
  clear` (wipes the history), `materialise` (deprecated: use `stateAt`),
  `recorded` / `bindAddress` (internal), and `RecordFrame · useAddress` (only
  before a frame's first write, which the frame does not check). The API page,
  `docs-site/src/content/docs/api/write.mdx`, says why for each.

```ts
import { buildRuntimeStageId, createExecutionCounter, stateAt, tagStops, timeTravel } from 'footprintjs/trace';
import { EventLog, RecordFrame, SharedMemory } from 'footprintjs/write';

const state = new SharedMemory(undefined, { count: 0, items: [] as number[] });
const log = new EventLog(state.getState()); // the frozen base (law 1)
const counter = createExecutionCounter(); // execution indices rise, never reset (law 5)

/** One step: a fresh frame, its writes, one commit — one bundle (law 3). */
function step(stageId: string, write: (frame: RecordFrame) => void, tags?: string[]) {
  const frame = new RecordFrame(state, log);
  frame.useEncoding({ commitValues: 'delta', writeProvenance: 'off' });
  write(frame);
  frame.commit(() => ({ stage: stageId, stageId, runtimeStageId: buildRuntimeStageId(stageId, counter.value++), tags }));
}

step('seed', (f) => f.write(f.at([], 'count'), 1, 'set'));
step('grow', (f) => f.write(f.at([], 'items'), [10], 'set'), ['milestone:step']); // an `append` of [10]
step('forget', (f) => f.write(f.at([], 'count'), undefined, 'delete'));
step('idle', () => {}); // wrote nothing: still a bundle, a stop the cursor can stand on

const record = { initialState: log.getInitialState(), commitLog: log.list() };
stateAt(record, 1).state; // { count: 1, items: [10] }
stateAt(record, 3).state; // { items: [10] }
timeTravel(record, { strategy: tagStops(['milestone:step']) }).stops; // start, the `grow` stop, end
```

The full example, with a redacted write and the readers that read it, is
`examples/post-execution/time-travel/07-write-a-record.ts`.

## Enforced by

- `test/lib/time-travel/record-contract.test.ts` — the hand-built record
  folds through all four verbs; every gap reason above, verbatim; an
  unknown verb is a gap, not a merge.
- `test/lib/time-travel/stored-recording.test.ts` — a stored record drives
  the cursor with no cast.
- `test/lib/time-travel/fold-memo.test.ts` — the fold never touches the
  record, and stepping equals a fresh fold at every stop.
- `test/lib/memory/scenario/write-door-same-bytes.test.ts` — the same steps
  written through `footprintjs/write` and run as a flowchart give the same
  commit log, byte for byte, and the readers answer the same on both.
- `test/fixtures/hcifootprint/hcifootprint-2.6.1.test.ts` — a real
  producer's stored transitions, replayed through `footprintjs/write`, give
  the stored bytes.
- `test/architecture/write-door.test.ts` — `footprintjs/write` names and
  loads nothing of the engine.
