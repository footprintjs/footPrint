---
name: Detach
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/
---

# Detach — Fire-and-Forget Child Flowcharts

`scope.$detachAndJoinLater(...)` and `scope.$detachAndForget(...)` schedule a
child flowchart on a chosen **driver** without blocking the parent stage.
Use them for telemetry exports, background indexing, parallel evaluations,
and any work that should ride alongside the main pipeline rather than
inside it.

```
                    parent stage (returns immediately)
                            │
                            ├─ driver.schedule(child, input, refId)
                            │       │
                            │       ▼
                            │   driver's queue
                            │       │
                            │       ▼ (microtask, immediate, or whatever)
                            │   child flowchart runs
                            │       │
                            │       ▼
                            │   handle.status = 'done' / 'failed'
                            ▼
                       (parent already moved on)
```

## Two surfaces

- **Inside a stage:** `scope.$detachAndJoinLater(driver, child, input)` /
  `scope.$detachAndForget(driver, child, input)`. refId is minted from the
  calling stage's `runtimeStageId` for diagnostic correlation.

- **Outside any chart:** `executor.detachAndJoinLater(driver, child, input)` /
  `executor.detachAndForget(driver, child, input)`. refId uses the synthetic
  `__executor__` prefix.

## Two semantics

| Method                  | Returns          | Use when                                              |
|-------------------------|------------------|-------------------------------------------------------|
| `detachAndJoinLater`    | `DetachHandle`   | You want the result later (await, status check, fan-out) |
| `detachAndForget`       | `void`           | Pure fire-and-forget (telemetry, audit log, etc.)     |

## Pick a driver

Built-in (more in v4.17.1):

| Driver                  | When                                              |
|-------------------------|---------------------------------------------------|
| `microtaskBatchDriver`  | Default. Coalesces many detaches into one microtask flush. Lowest latency. |
| `immediateDriver`       | Sync execution inside `schedule()`. Good for tests + small payloads.       |

Driver is a REQUIRED first argument — there is no library-default. Pass it
explicitly so the choice of scheduling algorithm is visible at the call site.

## Examples in this folder

| File                       | Topic                                           |
|----------------------------|-------------------------------------------------|
| `01-fire-and-forget.ts`    | Telemetry export — discard handle, don't await  |
| `02-join-later-fanout.ts`  | Fan out N detaches, await all via Promise.all   |
| `03-bare-executor.ts`      | Detach from outside any chart                   |
| `04-immediate-for-tests.ts`| Use immediateDriver for deterministic tests     |
| `05-error-handling.ts`     | Child fails — surfacing via `wait().catch()`    |
| `06-status-polling.ts`     | Read `handle.status` synchronously (no await)   |
| `07-graceful-shutdown.ts`  | Drain all in-flight detaches via `flushAllDetached` |
| `08-builder-native.ts`     | `addDetachAndForget` / `addDetachAndJoinLater` chart stages |

## Gotchas

- **Don't store handles in scope state.** `executor.getSnapshot()` JSON-
  serializes the shared state, which strips the handle's class methods
  (including `wait()`). Keep handles in closure-local variables.
- **`detachAndForget` errors go silent unless surfaced.** The driver still
  routes failures to the (discarded) handle — but no one is observing.
  Wire a recorder, or use `detachAndJoinLater` if you need to know.
- **Driver is required.** No library-default — pass `microtaskBatchDriver`
  (or your own) explicitly.
