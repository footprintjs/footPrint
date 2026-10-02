# pause/ — what a paused run is made of

The vocabulary of pause and resume: the two signals a stage can raise (`PauseSignal`, `InterruptSignal`), the `interrupt(scope, payload)` call, the serializable `FlowchartCheckpoint` (with `PendingPause` for parallel siblings) and the `PausableHandler` / `PauseResult` shapes. It owns the *types and the raise*; it does not own the walk back in — that is `engine/handlers/ResumeEntry.ts`, `StageRunner` and `runner/FlowChartExecutor` (`buildPauseCheckpoint`, `resume`).

**The laws.**

- *Two raise shapes, one checkpoint.* A stage pauses either because it was declared pausable (`addPausableFunction`: the first half returns a `PauseResult`, `resume` runs the second half) or because an ordinary body called `interrupt()`; `FlowchartCheckpoint.pausedBy` tells them apart.
- *An interrupt re-runs the stage from its top.* Everything before the call runs again, and the answer comes back out of the `interrupt()` call through a WeakMap keyed by the scope (`provideInterruptAnswer`) — which is why `interrupt` takes the scope first: there is no ambient "current stage" under parallel fan-out. It rides the error path's shape: `onStageEnd` does not fire, and writes made before it are committed (`test/lib/pause/interrupt.test.ts`).
- *A checkpoint is plain data and only grows optional fields.* It is JSON-safe (no functions, no class instances), so it can sit in Redis or a file. `pausedBy`, `executionCount`, `visitCounts` and `pendingPauses` are optional, so an older checkpoint still resumes (`test/lib/pause/resume-real-chart-9.27.0-checkpoints.test.ts`). `continuationStageId` is a record, never an instruction: what runs after a resume is read from the chart, so an edited checkpoint cannot redirect a run.
- *What a resume does not rebuild is pinned* — a pause inside a lazy subflow is refused, a paused branch stage resumes in its dispatcher's namespace, a failing resumed fork child fails the run (`test/lib/pause/resume-known-limitations.test.ts`) — and a paused-and-resumed run equals the never-paused one (a property test, `resume-real-chart.property.test.ts`).

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
  const checkpoint = executor.getCheckpoint()!; // plain JSON — persist it anywhere
  await new FlowChartExecutor(chart).resume(checkpoint, { approved: true });
}
```

Layer L0 (`scripts/layering.config.cjs`): a leaf, it imports nothing. Public through `footprintjs`: `interrupt`, and the `FlowchartCheckpoint`, `PausableHandler`, `PendingPause` and `InterruptPayload` types. See also [`../README.md`](../README.md) and the resume re-entry section of [`../engine/README.md`](../engine/README.md).
