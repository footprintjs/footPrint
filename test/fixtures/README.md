# Record bytes — the pinned fixtures

**Why.** The clean-up that moves the record half of a frame out of `StageContext` (steps C1–C6 of the writer-door design) must not move a single byte of the record. These fixtures pin the bytes footprintjs 9.44.1 writes, so a later change that moves one fails a test that names the scenario and shows the line.

| What | Pinned in | Checked by |
|---|---|---|
| 26 small flowchart runs: everything `getSnapshot()` serves (commit log, `initialState`, state, execution tree, subflow results, the dials, the log address), plus the checkpoint and the resumed run when one pauses, `getSnapshot({ redact: true })` under a policy, and how a failed run failed | `record-bytes/pinned/<scenario>.json` | `record-bytes/record-bytes.test.ts` |
| hcifootprint 2.6.1's real transitions, replayed through the public writer | [foottrace's unchanged fixture](https://github.com/footprintjs/foottrace/blob/main/test/fixtures/hcifootprint/transitions-2.6.1.json) | foottrace's writer replay suite |

**How bytes are compared** (`bytes.ts · pinnedText`). JSON with key order kept, written by `stringifySnapshot` (the record's own encoder), after one pass that spells what JSON drops and settles what the clock stamps:

```text
new Date('2026-07-02')        → "«date:2026-07-02T00:00:00.000Z»"
new Map([['k', 1]])           → { "«map»": [["k", 1]] }
new Set(['a'])                → { "«set»": ["a"] }
{ gone: undefined }           → { "gone": "«undefined»" }
"1759912345678-0000000003"    → "«run:1»"   (a run id; numbered by first appearance)
timestamp: 1759912345678      → "«time»"    (also pausedAt and startedAt)
durationMs: 812               → "«ms»"      (an attempt's timing, 10.1)
```

Everything else is JSON as the record writes it, with JSON's own losses: `NaN` and `±Infinity` become `null`, `-0` becomes `0`, an `Error` or `RegExp` becomes `{}`. The settlings match by shape, so they would also catch user data shaped like them: any number under a key named `timestamp`, `pausedAt`, `startedAt` or `durationMs`, and any string shaped `<digits>-<10 digits>`. None of these occur in today's pins as user data; `startedAt` and `durationMs` appear only on the attempt records 10.1 put on a retried stage's execution-tree node (the `retry` scenario).

## The re-pin policy — adopted 2026-10-09

A pinned byte changes for one of two reasons, and the PR says which:

1. **A bug.** The change broke the record. Fix the code; the fixture stays as it is.
2. **A named law fix.** The release changes a stated law of the record on purpose, as 9.22.0 did when a new Date, Map or Set became a change. It re-pins in a **minor**, in the same PR as the fix, and the CHANGELOG names it under **"Record bytes"**: the law, the scenarios that moved, and why.

**A refactor never re-pins.** The C1–C6 clean-up and E1–E6 extraction leave every pinned byte untouched (`record-bytes/pinned/` here, and `hcifootprint/transitions-2.6.1.json`, now in foottrace). Extraction may move a fixture to foottrace; it does not regenerate it. Any byte change other than a named law fix requires a major release (the extraction plan, section 7.4).

Re-pin, only for a named law fix, then read the diff — every changed line must be the law's:

```bash
RECORD_BYTES_REPIN=1 npx vitest run test/fixtures
```

## The flowchart scenarios (`record-bytes/scenarios.ts`)

The first nine are the charts of the former byte-identity probe script (removed when these fixtures were pinned, #61), promoted: now stored and checked on every run. The probe also dumped the narrative and the resume's return value; those are not record bytes and are not pinned here (the execution tree pins the same retained values).

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
| `retry` | Two failed attempts: their writes, reads and untracked source (`$getArgs`) reach neither the log nor the final bundle's `readKeys` / `untrackedSources`; the stage's declared tag survives the discards. Re-pinned in 10.1 (a named law, the attempt record): the stage's execution-tree node gains its three `attempts` and their `attemptSummary`; the log's bytes did not move. |
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
| `readTiers` | Before the first write an in-place edit changes the committed value itself, so writing it back records nothing (M1b). The second stage deletes x and reads it in that same stage: the corrected #124 law returns undefined, and the scenario's own `live.push` throws before its former writeback. The deletion commits; the exact failure, retained undefined read/write/state, error attention and one commit row are pinned. |

C2 (10.2) adds optional attention to the four already abnormal fixtures: `failures`, `forkError`, `retry` and
`throttledFork`. The other 22 pins are unchanged. `attention-byte-law.test.ts` checks all
26 outputs against captured pre-C2 hashes after removing optional attention. PR104 adds one narrower
projection: only `failures.uncloneable.snapshot.executionTree.next.errors.stageExecutionError` is removed,
after asserting its exact node identity, equality with `uncloneable.failed`, and exact error-attention proof.
Commit logs, other diagnostics, operational checkpoints and every other byte remain guarded against the
captured hashes. The served commit-error fix adds only that diagnostic and its proof-backed attention;
the pre-existing `stageThrows` attention remains unchanged.

The 11.0 update for the corrected read-after-delete law (#124, foottrace 1.11.1) changes only
`readTiers.json` and that scenario's hash. Both runtimes' actual captures must agree before adoption.
Its exact deleted-key read, scenario-owned TypeError, retained deletion, error diagnostic and attention
are asserted by the native failure witness and the closed candidate analysis; every other byte stays
exact. The other scenarios' pins and hashes are unchanged. The temporary capture steps are removed
after adoption; the bounded one-scenario test remains available without writing either pin.

The 11.0 attempt-effects major renamed `succeeded` to `answered`. Both byte tests use one explicit
test-only version projection for the `retry` scenario: it first asserts the exact `flaky#1` stage, its three
physical outcomes/reasons and first-filter match states, and the new `answered` labels/reasons. On a detached
JSON copy it then restores only the three `decision.rules[0].label` fields, the final attempt's `reason`, and
`attemptSummary.last.reason` to the historical spelling before the unchanged full byte/hash comparison. No
other field or scenario is projected. Historical JSON files and captured hashes stay unchanged; the re-pin
switch refuses `retry` while this version projection is present, so it cannot persist projected output silently.

## The hcifootprint fixture moved to foottrace

E3 moved the captured transitions byte for byte to foottrace, with the `foottrace/write` replay.
The old 2.6.1 engine-frame replay is retired: hcifootprint has written through the public record
writer since 2.7.0. The 26 flowchart fixtures above continue to pin what the engine's frame writes
through foottrace. No fixture was regenerated or re-pinned for extraction.
