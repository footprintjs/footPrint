# scope/recorders/ — the two built-in data-flow observers

`DebugRecorder` (errors, pauses and resumes always; reads, writes and stage start / end in `'verbose'` mode — for troubleshooting) and `MetricRecorder` (per-step timing and read / write / commit counts, keyed by `runtimeStageId`, with per-stage totals computed on read). Both are `ScopeRecorder`s: they watch what a stage reads and writes. This folder owns those two classes and the barrel of event types they share; it does not own the `ScopeRecorder` interface (`scope/types.ts`), how events are routed or delivered (`recorder/`, `runner/`) or the `metrics()` / `debug()` factories (`src/recorders.ts`).

**The laws.**

- *A recorder only watches.* Events carry live references, so a hook must not mutate them, and a hook that throws cannot break `run()` (`test/lib/scope/property/recorder-never-breaks-execution.test.ts`) — except `onResume`, which `FlowChartExecutor · resume` calls unguarded, so a throwing one rejects `resume()`.
- *Known gap — `MetricRecorder` attributes by the last stage to start.* `onRead`, `onWrite`, `onCommit`, `onPause` and `onStageEnd` write into the stage that most recently fired `onStageStart` and ignore the event's own `runtimeStageId`, so under a fork the counts and durations of concurrent stages land on the wrong key: commit and pause counts always go to the last-started child, and reads, writes and durations do too once a child awaits (a probe whose A awaited before its 2 writes, with B making 1, recorded `a#1` 0 writes and `b#2` 3).
- *Storage is composed, not inherited.* `MetricRecorder` holds a `KeyedStore<StepMetrics>` as a field — the recorder observes, the store stores — and its aggregate views are folded when asked, never kept in step.
- *Identity decides coexistence.* Each instance takes an auto-increment id (`debug-1`, `metrics-2`), so differently-configured recorders live side by side, while attaching the same id replaces; `new MetricRecorder('metrics')` is how an app overrides a framework-attached one. `clear()` runs before each `run()`, so nothing accumulates across runs (`test/lib/runner/unit/attach-recorder.test.ts`; the two recorders' own unit tests only call `clear()` / `reset()` directly).
- *`summarizeValue.ts` is a deprecated re-export* of `capture/summarize`: nothing under `src/` may import it, and `npm run check:layering` fails if something does.

```typescript
import { DebugRecorder, flowChart, FlowChartExecutor, MetricRecorder } from 'footprintjs';

const executor = new FlowChartExecutor(flowChart<{ n: number }>('Count', (scope) => { scope.n = 1; }, 'count').build());
const metrics = new MetricRecorder();
const debug = new DebugRecorder({ verbosity: 'minimal' }); // errors, pauses and resumes only
executor.attachScopeRecorder(metrics);
executor.attachScopeRecorder(debug);
await executor.run();

console.log(metrics.getByKey('count#0')); // { stageName: 'Count', readCount: 0, writeCount: 1, commitCount: 1, … } — one step
console.log(metrics.getMetrics().totalWrites, debug.getErrors().length); // 1 0
```

Layer L5 (`scripts/layering.config.cjs`): imports `recorder/` (`KeyedStore`, `RecorderOperation`), `scope/types` and — for the shim only — `capture/summarize`. Both classes are on `footprintjs`. See also [`../README.md`](../README.md).
