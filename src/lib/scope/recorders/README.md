# scope/recorders/ — the two built-in data-flow observers

`DebugRecorder` (errors always; reads, writes and stage lifecycle in `'verbose'` mode — for troubleshooting) and `MetricRecorder` (per-step timing and read / write / commit counts, keyed by `runtimeStageId`, with per-stage totals computed on read). Both are `ScopeRecorder`s: they watch what a stage reads and writes. This folder owns those two classes and the barrel of event types they share; it does not own the `ScopeRecorder` interface (`scope/types.ts`), how events are routed or delivered (`recorder/`, `runner/`) or the `metrics()` / `debug()` factories (`src/recorders.ts`).

**The laws.**

- *A recorder only watches.* Events carry live references, so a hook never mutates them, and a hook that throws cannot break the run (`test/lib/scope/property/recorder-never-breaks-execution.test.ts`).
- *Storage is composed, not inherited.* `MetricRecorder` holds a `KeyedStore<StepMetrics>` as a field — the recorder observes, the store stores — and its aggregate views are folded when asked, never kept in step.
- *Identity decides coexistence.* Each instance takes an auto-increment id (`debug-1`, `metrics-2`), so differently-configured recorders live side by side, while attaching the same id replaces; `new MetricRecorder('metrics')` is how an app overrides a framework-attached one. `clear()` runs before each `run()`, so nothing accumulates across runs (`test/lib/scope/unit/MetricRecorder.test.ts`, `DebugRecorder.test.ts`).
- *`summarizeValue.ts` is a deprecated re-export* of `capture/summarize`: nothing under `src/` may import it, and `npm run check:layering` fails if something does.

```typescript
import { DebugRecorder, flowChart, FlowChartExecutor, MetricRecorder } from 'footprintjs';

const executor = new FlowChartExecutor(flowChart<{ n: number }>('Count', (scope) => { scope.n = 1; }, 'count').build());
const metrics = new MetricRecorder();
const debug = new DebugRecorder({ verbosity: 'minimal' }); // errors and stage lifecycle only
executor.attachScopeRecorder(metrics);
executor.attachScopeRecorder(debug);
await executor.run();

console.log(metrics.getByKey('count#0')); // { stageName: 'Count', readCount: 0, writeCount: 1, commitCount: 1, … } — one step
console.log(metrics.getMetrics().totalWrites, debug.getErrors().length); // 1 0
```

Layer L5 (`scripts/layering.config.cjs`): imports `recorder/` (`KeyedStore`, `RecorderOperation`), `scope/types` and — for the shim only — `capture/summarize`. Both classes are on `footprintjs`. See also [`../README.md`](../README.md).
