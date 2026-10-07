# pause/ — what a paused run is made of

The vocabulary of pause and resume: the two signals a stage can raise (`PauseSignal`, `InterruptSignal`), the `interrupt(scope, payload)` call, the serializable `FlowchartCheckpoint` (with `PendingPause` for parallel siblings) and the `PausableHandler` / `PauseResult` shapes. It owns the *types, the raise and the record codec* (`record.ts`); it does not own the walk back in — that is `engine/handlers/ResumeEntry.ts`, `StageRunner` and `runner/checkpoint.ts · buildPauseCheckpoint` and `runner/resume.ts · planResume`.

**The laws.**

- *Two raise shapes, one checkpoint.* A stage pauses either because it was declared pausable (`addPausableFunction`: when the first half returns anything but `undefined` the stage pauses and that value becomes the `pauseData` — `PauseResult`, `{ pause: true, data }`, is only an explicit wrapper whose `data` is unwrapped, see `engine/handlers/StageRunner` — and `resume` runs the second half) or because an ordinary body called `interrupt()`; `FlowchartCheckpoint.pausedBy` tells them apart.
- *An interrupt re-runs the stage from its top.* Everything before the call runs again, and the answer comes back out of the `interrupt()` call through a WeakMap keyed by the scope (`provideInterruptAnswer`) — which is why `interrupt` takes the scope first: there is no ambient "current stage" under parallel fan-out. It rides the error path's shape: `onStageEnd` does not fire, and writes made before it are committed (`test/lib/pause/interrupt.test.ts`).
- *A checkpoint is plain data and only grows optional fields.* It is built by one `structuredClone`, so it holds only cloneable data — no functions, and a user-class instance comes back as a plain object — and it can be stored as JSON too, as long as your state and payload are JSON-safe: a `Date` or a `Map` in state survives the clone but not a JSON round trip. `pausedBy`, `executionCount`, `visitCounts` and `pendingPauses` are optional, so an older checkpoint still resumes — one without `executionCount` / `visitCounts` (`test/lib/pause/resume-execution-counter-continuity.test.ts`), one written by 9.27.0, before `pendingPauses` (`test/lib/pause/resume-real-chart-9.27.0-checkpoints.test.ts`). What runs after a resume comes from the chart, never the checkpoint — but `pausedStageId` is trusted, it picks the stage a resume starts at, so treat a stored checkpoint as trusted input.
- *A checkpoint holds what a resume reads — never the run's history (format 2, the lean checkpoint).* The cursor (`pausedStageId`, `subflowPath`, `pausedBy`), the state (`sharedState`, plus `subflowStates`: one capture per subflow ON the pause path), the counters (`executionCount`, `visitCounts` — one entry per stage id), `pendingPauses`, `redactionMarks`, the link (`pausedExecution`) — and the pause's own record: `pauseData`, `invokerStageId`, `pausedAt`. So its size is the state's and the chart's, never the run's length. Format 1 also carried the whole execution tree and the finished subflows' results, which no resume read: after 60 agent turns whose resumable state (root plus captures) is 0.13 MB that was 19.3 MB, the tree alone 97% — now 0.13 MB, flat at 15, 60 or 240 turns (`npx tsx bench/checkpoint-size.ts`). The run's record is `getSnapshot()`'s — take it before `resume()` if you want it kept. The checkpoint keeps REAL values (no redaction policy touches it; the marks travel as names). Pinned: `test/lib/pause/checkpoint-size.test.ts` — the same checkpoint, up to its counters' digits, after 3 turns or 40 and after a finished subflow of 2 steps or 60; and a pause builds no snapshot at all.

```typescript
const checkpoint = executor.getCheckpoint()!; // what resume() needs — persist it
const record = executor.getSnapshot();        // what happened (tree, commit log, subflow results) — keep it if you want it
```
- *One codec reads a stored checkpoint: one version, one upcaster, one validator (`record.ts`, 9.39.0).* A checkpoint is written with `checkpointVersion: 2` (its first key). `resume()` hands whatever it is given to `decodeCheckpoint`, which runs the ONE upcaster — every step so far only drops fields: an unversioned checkpoint (any release before 9.39.0) is version 0, whose fields 9.14–9.37 added are optional and read as absent and whose legacy `continuationStageId` (a record no resume has read since 9.28.0) is dropped; a version 1 checkpoint (9.39.0–9.43.x) loses `executionTree` and `subflowResults`; a dropped field never survives whatever version claims to carry it, and a version this release does not know is refused — then checks every pause record with ONE function, `decodePauseRecord`, whether it is the checkpoint's own or a waiting sibling's `pendingPauses[n]`. One message set: `Invalid checkpoint: <path> <what>.` — `pausedStageId must be a non-empty string`, `pendingPauses[0].subflowPath must be an array of strings`, … Until 9.38.0 the two sites checked the same record twice with two message sets (and the top-level `pausedBy` / `subflowStates` not at all). Pinned: checkpoints written by 9.20.0, 9.27.0, 9.28.0 and 9.37.0 resume into the healthy run, and a table of malformed records is refused with the same sentence at both sites (`test/lib/pause/record.test.ts`).

```typescript
// A checkpoint stored by 9.37.0 (no checkpointVersion, maybe a continuationStageId) or by 9.43.0
// (checkpointVersion 1, with its execution tree) resumes as is — into the same run a lean one does:
await new FlowChartExecutor(chart).resume(JSON.parse(stored), answer);
// A malformed one is refused before anything is touched:
//   Invalid checkpoint: pendingPauses[0].pausedStageId must be a non-empty string.
```
- *What a resume does not rebuild is pinned* — a pause inside a lazy subflow is refused, a paused branch stage resumes in its dispatcher's namespace, a failing resumed fork child fails the run (`test/lib/pause/resume-known-limitations.test.ts`) — and for the chart family in `resume-real-chart.property.test.ts` a paused-and-resumed run has the same trace and final state as the never-paused one (the commit record still differs by design: the stand-in is one more execution of the paused stage).

```typescript
import { flowChart, FlowChartExecutor, interrupt } from 'footprintjs';

interface State { amount: number; approved: boolean; [key: string]: unknown }

const chart = flowChart<State>('Review', (scope) => {
  scope.amount = 4200; // runs AGAIN on resume — keep what comes before interrupt() idempotent
  const answer = interrupt<{ approved: boolean }>(scope, { reason: 'Approve this refund?' });
  scope.approved = answer.approved;
}, 'review').build();

const executor = new FlowChartExecutor(chart);
await executor.run();
if (executor.isPaused()) {
  const checkpoint = executor.getCheckpoint()!; // one structuredClone — store it (as JSON if your state is JSON-safe)
  await new FlowChartExecutor(chart).resume(checkpoint, { approved: true });
}
```

Layer L0 (`scripts/layering.config.cjs`): a leaf, it imports nothing. Public through `footprintjs`: `interrupt`, and the `FlowchartCheckpoint`, `PausableHandler`, `PendingPause` and `InterruptPayload` types. See also [`../README.md`](../README.md) and the resume re-entry section of [`../engine/README.md`](../engine/README.md).
