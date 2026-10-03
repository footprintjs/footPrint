# pause/ — what a paused run is made of

The vocabulary of pause and resume: the two signals a stage can raise (`PauseSignal`, `InterruptSignal`), the `interrupt(scope, payload)` call, the serializable `FlowchartCheckpoint` (with `PendingPause` for parallel siblings) and the `PausableHandler` / `PauseResult` shapes. It owns the *types, the raise and the record codec* (`record.ts`); it does not own the walk back in — that is `engine/handlers/ResumeEntry.ts`, `StageRunner` and `runner/checkpoint.ts · buildPauseCheckpoint` and `runner/resume.ts · planResume`.

**The laws.**

- *Two raise shapes, one checkpoint.* A stage pauses either because it was declared pausable (`addPausableFunction`: when the first half returns anything but `undefined` the stage pauses and that value becomes the `pauseData` — `PauseResult`, `{ pause: true, data }`, is only an explicit wrapper whose `data` is unwrapped, see `engine/handlers/StageRunner` — and `resume` runs the second half) or because an ordinary body called `interrupt()`; `FlowchartCheckpoint.pausedBy` tells them apart.
- *An interrupt re-runs the stage from its top.* Everything before the call runs again, and the answer comes back out of the `interrupt()` call through a WeakMap keyed by the scope (`provideInterruptAnswer`) — which is why `interrupt` takes the scope first: there is no ambient "current stage" under parallel fan-out. It rides the error path's shape: `onStageEnd` does not fire, and writes made before it are committed (`test/lib/pause/interrupt.test.ts`).
- *A checkpoint is plain data and only grows optional fields.* It is built by one `structuredClone`, so it holds only cloneable data — no functions, and a user-class instance comes back as a plain object — and it can be stored as JSON too, as long as your state and payload are JSON-safe: a `Date` or a `Map` in state survives the clone but not a JSON round trip. `pausedBy`, `executionCount`, `visitCounts` and `pendingPauses` are optional, so an older checkpoint still resumes — one without `executionCount` / `visitCounts` (`test/lib/pause/resume-execution-counter-continuity.test.ts`), one written by 9.27.0, before `pendingPauses` (`test/lib/pause/resume-real-chart-9.27.0-checkpoints.test.ts`). What runs after a resume comes from the chart, never the checkpoint — but `pausedStageId` is trusted, it picks the stage a resume starts at, so treat a stored checkpoint as trusted input.
- *One codec reads a stored checkpoint: one version, one upcaster, one validator (`record.ts`, 9.39.0).* A checkpoint is written with `checkpointVersion: 1` (its first key). `resume()` hands whatever it is given to `decodeCheckpoint`, which runs the ONE upcaster — an unversioned checkpoint (any release before 9.39.0) is version 0: every field 9.14–9.37 added is optional and read as absent, and the legacy `continuationStageId` (a record no resume has read since 9.28.0, no longer written) is dropped; a version this release does not know is refused — then checks every pause record with ONE function, `decodePauseRecord`, whether it is the checkpoint's own or a waiting sibling's `pendingPauses[n]`. One message set: `Invalid checkpoint: <path> <what>.` — `pausedStageId must be a non-empty string`, `pendingPauses[0].subflowPath must be an array of strings`, … Until 9.38.0 the two sites checked the same record twice with two message sets (and the top-level `pausedBy` / `subflowStates` not at all). Pinned: checkpoints written by 9.20.0, 9.27.0, 9.28.0 and 9.37.0 resume into the healthy run, and a table of malformed records is refused with the same sentence at both sites (`test/lib/pause/record.test.ts`).

```typescript
// A checkpoint stored by 9.37.0 (no checkpointVersion, maybe a continuationStageId) resumes as is:
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
