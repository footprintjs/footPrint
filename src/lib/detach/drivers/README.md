# detach/drivers/ — the six ways to run a detached child

Each file is one `DetachDriver` (`../types.ts`): an algorithm for *when and where* a detached child runs, built by a `create…Driver(…)` factory and — where it needs no options — also shipped as a ready-made singleton. They own scheduling only; the handle, the registry and the entry points live one level up in `detach/`. There is no default driver: every detach call passes one, and `microtaskBatchDriver` is only the one the docs and the missing-driver error name.

| Driver | Handle when `schedule()` returns | The work starts | Pick it for |
|---|---|---|---|
| `immediateDriver` | `running` | on the next microtask, one per call (`Promise.resolve().then(…)`), no batch | tests and debugging: no queue to flush before the handle is `running` |
| `microtaskBatchDriver` | `queued` | at the next microtask, one flush per batch | the usual in-process choice; browser, Node and edge |
| `setImmediateDriver` | `queued` | at Node's `setImmediate`, one flush per batch | after the current I/O tick, so a hot HTTP path flushes first |
| `setTimeoutDriver` | `queued` | after `delayMs` (factory option, default 0), one flush per batch | a chosen delay or coalescing; any runtime |
| `createSendBeaconDriver({ url })` | already `done` or `failed` | inside `schedule()`: the serialized input goes to `navigator.sendBeacon` | page-leave telemetry that must survive unload; browser only, ~64 KB |
| `createWorkerThreadDriver({ worker \| workerScript })` | `running` (`failed` if posting throws) | inside `schedule()`: the input is posted to your worker, and the handle settles on its reply | CPU-heavy work off the main thread; you supply the worker |

**The contract, and where it bends.** `schedule()` must return a fresh handle synchronously and report a child's failure through it (`../types.ts · DetachDriver`). No driver runs the child before returning: even `immediateDriver` only marks the handle `running` and starts the child on the next microtask (read from `createImmediateDriver`; `test/lib/detach/immediate.test.ts` P1 pins the `running` handle). The last two drivers never run the child *chart* at all — `sendBeacon` POSTs the serialized input and `workerThread` posts the input to your worker (the chart is ignored in v1) — so give them an input that serializes (JSON for `sendBeacon` unless you pass `serialize`; `structuredClone` for the worker). Each driver has its own test, `test/lib/detach/<driver>.test.ts`.

**Known gap.** The optional `validate()` hook is where a driver refuses an environment it cannot run in (`sendBeacon` outside a browser, `setImmediate` outside Node), but nothing in `src/` calls it, and `setImmediateDriver.schedule()` calls `setImmediate` outside any `try` — on a runtime without it the first call throws (the handle it registered is never unregistered) and every later call returns a handle stuck at `queued` that never runs, because the batch was already marked scheduled.

```typescript
import { createSetTimeoutDriver } from 'footprintjs/detach';

// Ship telemetry five seconds later, batched.
const slowDriver = createSetTimeoutDriver({ delayMs: 5000 });
slowDriver.capabilities.nodeSafe; // true — what a consumer inspects to pick a driver
```

Layer L7: a driver imports `../handle`, `../registry` and `../types`, `../runChild` for the in-process ones, and `builder/types` as a type — never the engine or the executor directly. See also [`../README.md`](../README.md).
