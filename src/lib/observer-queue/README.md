# observer-queue/ — deliver observer events "one beat behind", with the losses counted

The pure delivery pipeline behind `{ delivery: 'deferred' }` (RFC-001, `docs/design/rfc-001-deferred-observers.md`). A producer captures an event (`capture/envelope`), `MergedQueue` stamps it with a `seq` and stages it on a `BoundedRing`, `FlushDriver` drains the queue at the next microtask checkpoint under a time budget, and `DeferredDispatcher` hands each envelope to its listeners with isolation and accounting. It owns *when and in what order* an event is delivered; it does not know what an event means, which recorder wants it (that wiring is `runner/DeferredObserverTier.ts`), or how a payload is summarised (that is `capture/`).

**The laws.**

- *Bounded and counted.* The ring never grows past its bound and every loss is counted — `drops` for an evicted or sampled-out item, `rejections` for a `'block'` refusal, which is not a loss because the dispatcher then delivers that event inline (`ring.ts · BoundedRing`).
- *Ordered, with honest gaps.* `seq` is stamped *before* admission, starts at 0 and is never reused, so a drop leaves a visible gap in what listeners see (`mergedQueue.ts · MergedQueue`).
- *The flush cannot starve or stall.* `FlushDriver.arm` is idempotent, a flush drains a snapshot of the queue (listener-driven cascades land at the next checkpoint) and always makes progress on at least one item.
- *A listener cannot hurt anyone.* A throwing or rejecting listener never reaches a sibling or the producer, and the flush never awaits a listener (`deferredDispatcher.ts · DeferredDispatcher`).

Pinned by `test/lib/observer-queue/` — one test file per module.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart<{ total: number }>('Add', (scope) => { scope.total = 2 + 2; }, 'add').build();
const executor = new FlowChartExecutor(chart);

// Off the hot path: captured into the one bounded queue, delivered at the next checkpoint.
executor.attachScopeRecorder(
  { id: 'audit', onWrite: (e) => console.log('wrote', e.key) },
  { delivery: 'deferred', overflow: 'drop-oldest', maxQueue: 1000 },
);
await executor.run();
await executor.drainObservers(); // settle async listeners before shutdown
console.log(executor.getSnapshot().observerStats); // counted drops, per-listener time
```

The module is internal; the public door is the attach option (`AttachRecorderOptions`) and the types the root barrel re-exports (`CapturePolicy`, `OverflowPolicy`, `DispatcherStats`, `ListenerStats`). Guide: [`docs/guides/observers-deferred.md`](../../../docs/guides/observers-deferred.md).

Layer L1 (`scripts/layering.config.cjs`): the table allows L0–L1, and the folder keeps to the stricter rule in its barrel header — only `capture/envelope` and its own files, zero engine imports; `runner/` imports *it*, never the reverse. See also [`../README.md`](../README.md) and [`../capture/README.md`](../capture/README.md).
