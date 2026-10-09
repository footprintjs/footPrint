# Record bytes — the pinned fixtures

**Why.** The clean-up that moves the record half of a frame out of `StageContext` (steps C1–C6 of the writer-door design) must not move a single byte of the record. These fixtures pin the bytes footprintjs 9.44.1 writes, so a later change that moves one fails a test that names the scenario and shows the line.

| What | Pinned in | Checked by |
|---|---|---|
| 26 small flowchart runs: everything `getSnapshot()` serves (commit log, `initialState`, state, execution tree, subflow results, the dials, the log address), plus the checkpoint and the resumed run when one pauses, `getSnapshot({ redact: true })` under a policy, and how a failed run failed | `record-bytes/pinned/<scenario>.json` | `record-bytes/record-bytes.test.ts` |
| hcifootprint 2.6.1's real transitions: the calls it made and the log, fold base, state and reads they gave — replayed through 2.6.1's `/advanced` calls and through `footprintjs/write` (2.7.0) | `hcifootprint/transitions-2.6.1.json` | `hcifootprint/hcifootprint-2.6.1.test.ts` |

**How bytes are compared** (`bytes.ts · pinnedText`). JSON with key order kept, written by `stringifySnapshot` (the record's own encoder), after one pass that spells what JSON drops and settles what the clock stamps:

```text
new Date('2026-07-02')        → "«date:2026-07-02T00:00:00.000Z»"
new Map([['k', 1]])           → { "«map»": [["k", 1]] }
new Set(['a'])                → { "«set»": ["a"] }
{ gone: undefined }           → { "gone": "«undefined»" }
"1759912345678-0000000003"    → "«run:1»"   (a run id; numbered by first appearance)
timestamp: 1759912345678      → "«time»"    (also pausedAt)
```

Everything else is JSON as the record writes it, with JSON's own losses: `NaN` and `±Infinity` become `null`, `-0` becomes `0`, an `Error` or `RegExp` becomes `{}`. The two settlings match by shape, so they would also catch user data shaped like them: any number under a key named `timestamp` or `pausedAt`, and any string shaped `<digits>-<10 digits>`. None of these occur in today's pins.

## The re-pin policy — adopted 2026-10-09

A pinned byte changes for one of two reasons, and the PR says which:

1. **A bug.** The change broke the record. Fix the code; the fixture stays as it is.
2. **A named law fix.** The release changes a stated law of the record on purpose, as 9.22.0 did when a new Date, Map or Set became a change. It re-pins in a **minor**, in the same PR as the fix, and the CHANGELOG names it under **"Record bytes"**: the law, the scenarios that moved, and why.

**A refactor never re-pins.** The C1–C6 clean-up and E1–E6 extraction leave every pinned byte untouched (`record-bytes/pinned/` and `hcifootprint/transitions-2.6.1.json`). Extraction may move a fixture to foottrace; it does not regenerate it. Any byte change other than a named law fix requires a major release (the extraction plan, section 7.4).

Re-pin, only for a named law fix, then read the diff — every changed line must be the law's:

```bash
RECORD_BYTES_REPIN=1 npx vitest run test/fixtures
```

The hcifootprint calls (`open`, `transitions`) are never re-pinned: they are what 2.6.1 did. Only what they gave (`recorded`) moves, and only under the same rule.

## The flowchart scenarios (`record-bytes/scenarios.ts`)

The first nine are the charts of `scripts/byte-identity-probe.ts` (removed), promoted: now stored and checked on every run. The probe also dumped the narrative and the resume's return value; those are not record bytes and are not pinned here (the execution tree pins the same retained values).

| Scenario | Pins |
|---|---|
| `sequential` | Writes, a read-then-write (the first-touch base), an untouched stage (no buffer: the empty-commit fast path), a same-value write (the buffer's empty commit). |
| `fork` | Fork children write under `runs/<childId>`; each child's `phase: 'repeat'` settle bundle. |
| `forkError` | A child that throws: its writes still commit, its error text sits in the tree. |
| `subflow` | An eager mount: the seed as the subflow's `history[0]`, the merge-back as the mount's own bundle, then its `phase: 'exit'` bundle. |
| `forkSubflowBranch` | A selector fork whose subflow branch merges back into a parent root key mid-fork (`useAddressOf`). |
| `throttledFork` | A child that throws a `429` under a throttling checker writes nothing and records an empty bundle. The classification itself is an event (`onThrottled`), not a byte, so it is not pinned. |
| `deciderLoop` | `loopTo` and `$break`: one stage five times, an array grown by `$batchArray`. |
| `pauseResumeSame` | `addPausableFunction` (no `pausedBy`): the checkpoint, then a same-executor resume. |
| `pauseResumeCorner` | The resume writes a key back to its run-start value: still a change against the post-pause state. |
| `decider` | The decider commits before its branch resolves; the chosen branch writes at the root. |
| `lazySubflow` | A lazy mount with no `outputMapper`: its exit is its only bundle, with no `phase`. |
| `parallelForEach` | Branches `each~<index>`, each with its own log; `into` written by the fan-out; the third item truncated. |
| `interruptSubflow` | `interrupt()` inside a subflow: `pausedBy: 'interrupt'` and `subflowStates`; a resume from the stored (JSON) checkpoint re-seeds the subflow and re-runs the stage. |
| `retry` | Two failed attempts: their writes, reads and untracked source (`$getArgs`) reach neither the log nor the final bundle's `readKeys` / `untrackedSources`; the stage's declared tag survives the discards. |
| `redactionPolicy` | `keys`, `patterns` and `fields`; objects copied under new names keep their rule (fields and whole); a merge under a whole rule and one carrying a field secret (`updates` scrubbed); a seeded secret and `defaultValuesForContext` (the mirror's seed, the fold base); the served mirror — under each retention dial (`full`, `summary`, and `off` under `'delta'`, where the redacted array is an `append`). |
| `redactionMarks` | Per-call marks: declared once, cleared by a delete, carried by `checkpoint.redactionMarks` into the resumed run. |
| `verbs` | `set`, `merge`, `delete` and `append` (an array grown by a tail), under `'full'` and `'delta'`. |
| `values` | Date, Map and Set (an equal value is no change, a different one is), an own `undefined`; both encodings. |
| `readsPrefix` | `writeProvenance: 'reads-prefix'`: each row's `readKeys`, a read of the stage's own write included — the same under each retention dial. |
| `tags` | The bundle's fragments in order: `untrackedSources`, `tags` (on an empty commit too), and a tagged mount whose `phase: 'exit'` bundle carries none. |
| `firstTouch` | The diff base is the state at first touch: a fork child reads `k`, a sibling commits a new `k`, the child writes back what it read, and no row is recorded. A key the sibling committed after that first touch is still read, from live state (the second read tier). |
| `addresses` | Where a frame writes: a fork child's no-op delete under its `runs/<id>` address commits nothing (the buffer's address), and a subflow child's per-field merge-back lands at its parent's address (`useAddressOf`). |
| `nestedPaths` | The facade's path-aware doors in fork children under `runs/<id>`: a nested tracked read (`readKeys: ['profile.name']`), a nested write under a field rule, a merge, and an object read under a ruled name written at a nested path (its rule re-based there). A sibling merges, hard-writes and merges one key again: a family that does not fold back, re-encoded as what the stage read. |
| `subflowBoundary` | Writes at a subflow's boundary under a policy and `'reads-prefix'`: the seed (a mapper's copies keep their rule; a plain object seeds field by field), a mark made inside the subflow, a fork inside it (`runs/sf-in/p`, one segment), and every merge-back shape — a scalar, a top-level array concatenated, a plain object merged field by field — with their reads in `readKeys`. |
| `failures` | A stage that throws still commits its writes and the run rejects; a write nothing can clone fails at commit, records nothing, and the snapshot is still served. |
| `readTiers` | The two read tiers, out of contract on purpose (an in-place edit of a read, written back). Before the first write the read is the committed value itself (the lazy buffer), so nothing is recorded (M1b). After it, a read the working copy cannot answer comes from live state with the diff base detached first (`detachBase`), so the edit is recorded (B2). |

## The hcifootprint fixture (`hcifootprint/`)

Seven sessions: the six of hcifootprint 2.6.1's `test/trace.test.ts` (both encodings, a redacted key, the growing cart, a Date, a changed Date/Map/Set, an own-`undefined` report, 25 revisits) and the writer-door design's out-of-order commit (fire `login`, a `push` stimulus commits, then `login` settles, so the log reads `stimulus:push#1, login#0`). Each session holds `open` (2.6.1's `ExecutionRuntime` arguments), `transitions` (each frame's `newRoot`, reads, writes with their redact flag, and `runtimeStageId`, in commit order) and `recorded`. The three sessions that register handlers end with 2.6.1's own empty `stimulus:structure-swap` commit, which it queues when its served structure changes.

**Captured once**, on 2026-10-08, by running those sessions in a copy of hcifootprint 2.6.1 (main `bcb6306`, its lockfile's footprintjs 9.44.1 from npm). A vitest module mock wrapped `footprintjs/advanced` and recorded every `ExecutionRuntime`, `newRoot`, `ScopeFacade · getValue` / `setValue` and `commit`. The same sessions run without the mock gave the same log, state and reads. hcifootprint itself was not edited.

The test replays each session twice, against the same bytes: through 2.6.1's constructor and `#commitDelta`, copied verbatim (an `ExecutionRuntime`, a frame from `newRoot` and a `ScopeFacade` with a read tap, on `/advanced`), and through `footprintjs/write` (C5) — the calls hcifootprint 2.7.0's constructor and `#commitDelta` make, with the session's fields replaced by the captured values: a `SharedMemory`, an `EventLog`, and one `RecordFrame` per transition that notes the guard reads, stages each write (a redacted one with the `{ whole: true }` scrub) and commits under the transition's names. The second replay is `/write`'s promise to a real producer: the door writes what the engine's frame wrote.
