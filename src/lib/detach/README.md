# detach/ — fire-and-forget child charts, off the parent's hot path

A stage that must not wait for its side work (telemetry, an audit write) hands a child flowchart to a **driver** and returns at once. This folder owns the `DetachDriver` strategy interface (`types.ts`), the `DetachHandle` a detach gives back (`handle.ts`), the process-wide handle registry (`registry.ts`), `flushAllDetached` for graceful shutdown (`flush.ts`) and the one primitive behind every entry point (`spawn.ts`: `scope.$detachAndJoinLater` / `$detachAndForget`, `executor.detachAndJoinLater`, the builder's `addDetachAndForget` sugar). The six built-in drivers are in [`drivers/`](./drivers/README.md); how a child chart is actually *run* is `runChild.ts`, not here.

**The laws.**

- *Drivers are passed explicitly* — no default driver and no driver registry, so the engine never imports one (`spawn.ts`).
- *A driver returns synchronously and never throws*: a scheduling or child failure lands on the handle (`status: 'failed'`, `error`), never on the parent stage (`types.ts · DetachDriver`).
- *A handle only moves forward* — `queued → running → done | failed` — and `wait()` hands back one cached promise (`handle.ts · HandleImpl`, `test/lib/detach/handle.test.ts`).
- *The registry is process-wide because the drivers' queues are.* `flushAllDetached` loops until it is empty, so a detach made by a child is drained too, and settles with `Promise.allSettled` under a deadline (`test/lib/detach/flush.test.ts`).
- *The executor is reached lazily* — `runChild.ts · defaultRunChild` does a dynamic `import()` — so a driver never pulls the runner into a bundle or closes an import cycle.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { flushAllDetached, microtaskBatchDriver } from 'footprintjs/detach';

const audit = flowChart<{ seen: boolean }>('Audit', (scope) => { scope.seen = true; }, 'audit').build();

const handle = new FlowChartExecutor(audit).detachAndJoinLater(microtaskBatchDriver, audit, { event: 'viewed' });
console.log(handle.status); // 'queued' — schedule() returned before any work ran
await flushAllDetached();   // shutdown: drain every in-flight handle
console.log(handle.status); // 'done'
```

Layer L7 (`scripts/layering.config.cjs`): imports `builder/types` as types only, and `runner/FlowChartExecutor` only through that dynamic import. One edge is named on purpose: `scope/ScopeFacade.ts → detach/spawn.ts` (`scope.$detachAndJoinLater` / `$detachAndForget` delegate to the same primitive), which is legal because `spawn.ts` never imports `scope/`. Public through `footprintjs/detach` (`src/detach.ts`). See also [`../README.md`](../README.md).
