# detach/ — fire-and-forget child charts, off the parent's hot path

A stage that must not wait for its side work (telemetry, an audit write) hands a child flowchart to a **driver** and returns at once. This folder owns the `DetachDriver` strategy interface (`types.ts`), the `DetachHandle` a detach gives back (`handle.ts`), the process-wide handle registry (`registry.ts`), `flushAllDetached` for graceful shutdown (`flush.ts`) and the one primitive behind every entry point (`spawn.ts`: `scope.$detachAndJoinLater` / `$detachAndForget`, `executor.detachAndJoinLater`, the builder's `addDetachAndForget` sugar). The six built-in drivers are in [`drivers/`](./drivers/README.md); `runChild.ts` is the one hook that actually runs a child chart, and the in-process drivers call it.

**The laws.**

- *Drivers are passed explicitly* — no default driver and no driver registry, so the engine never imports one (`spawn.ts`).
- *A driver returns a handle synchronously and reports failure through it*: a scheduling or child failure lands on the handle (`status: 'failed'`, `error`), not on the parent stage (`types.ts · DetachDriver`). One driver bends this — see the known gap in [`drivers/`](./drivers/README.md).
- *A handle only moves forward* — `queued → running → done | failed` — and `wait()` hands back one cached promise (`handle.ts · HandleImpl`, `test/lib/detach/handle.test.ts`).
- *The registry is process-wide because the drivers' queues are.* `flushAllDetached` loops until it is empty, so a detach made by a child is drained too, and settles with `Promise.allSettled` under a deadline (`test/lib/detach/flush.test.ts`).
- *The executor is reached lazily* — `runChild.ts · defaultRunChild` does a dynamic `import()` — so the runner is not in a driver's static import graph and cannot close a load-time cycle. A bundler without code splitting still inlines it (a plain esbuild bundle of `microtaskBatchDriver` alone contains the executor); with splitting it becomes a lazy chunk.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { flushAllDetached, microtaskBatchDriver } from 'footprintjs/detach';

const audit = flowChart<{ seen: boolean }>('Audit', (scope) => { scope.seen = true; }, 'audit').build();

const handle = new FlowChartExecutor(audit).detachAndJoinLater(microtaskBatchDriver, audit, { event: 'viewed' });
console.log(handle.status); // 'queued' — schedule() returned before any work ran
await flushAllDetached();   // shutdown: drain every in-flight handle
console.log(handle.status); // 'done'
```

Layer L7 (`scripts/layering.config.cjs`): imports `builder/types` as types only, and `runner/FlowChartExecutor` only through that dynamic import. One upward edge points in: `scope/ScopeFacade.ts → detach/spawn.ts` (`scope.$detachAndJoinLater` / `$detachAndForget` delegate to the same primitive). The layer table forbids it (L5 → L7) and `EXCEPTIONS` names it; it cannot close a cycle because `spawn.ts` never imports `scope/`. Public through `footprintjs/detach` (`src/detach.ts`). See also [`../README.md`](../README.md).
