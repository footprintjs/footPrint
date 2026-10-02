# detach/drivers/ — the six ways to defer detached work

Each file is one `DetachDriver` (`../types.ts`): an algorithm for *when and where* a detached child runs, built by a `create…Driver(…)` factory and — where it needs no options — also shipped as a ready-made singleton. They own scheduling only; the handle, the registry and the entry points live one level up in `detach/`.

| Driver | Defers to | Pick it for |
|---|---|---|
| `immediateDriver` | nothing — runs inside `schedule()` | tests and debugging; deterministic, synchronous |
| `microtaskBatchDriver` | one `queueMicrotask` per batch | the in-process default; browser, Node and edge |
| `setImmediateDriver` | Node's `setImmediate` | after the current I/O tick, so a hot HTTP path flushes first |
| `setTimeoutDriver` | `setTimeout(…, delayMs)` | a chosen delay or coalescing; any runtime (factory option `delayMs`) |
| `createSendBeaconDriver({ url })` | `navigator.sendBeacon` | page-leave telemetry that must survive unload; browser only, ~64 KB |
| `createWorkerThreadDriver({ worker \| workerScript })` | a worker thread | CPU-heavy work off the main thread; you supply the worker |

**The law: every driver honours the `DetachDriver` contract** — `schedule()` returns a fresh handle synchronously, registers it with the registry, never throws, and reports failure through the handle. The two network/worker drivers do **not** run the child chart: `sendBeacon` POSTs the serialized input and `workerThread` posts the input to your worker (the chart is ignored in v1), so give them an input that serializes (JSON for `sendBeacon` unless you pass `serialize`; `structuredClone` for the worker). Each driver has its own test, `test/lib/detach/<driver>.test.ts`.

```typescript
import { createSetTimeoutDriver } from 'footprintjs/detach';

// Ship telemetry five seconds later, batched.
const slowDriver = createSetTimeoutDriver({ delayMs: 5000 });
slowDriver.capabilities.nodeSafe; // true — what a consumer inspects to pick a driver
```

Layer L7: a driver imports `../handle`, `../registry` and `../types`, `../runChild` for the in-process ones, and `builder/types` as a type — never the engine or the executor directly. See also [`../README.md`](../README.md).
