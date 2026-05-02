---
name: Detach (Fire-and-Forget)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#fire-and-forget
---

# `$detachAndForget` — Telemetry Without Blocking

The simplest detach pattern: a stage finishes its real work, then asks
the driver to ship a side-effect chart (telemetry, audit log, cache
warm-up) — and returns immediately. The parent never waits.

```
ProcessOrder ─► commit + return
                  │
                  └─► driver flushes ─► TelemetryChart runs (microtask)
```

## When to use

- **Telemetry / analytics.** "Log this completed step somewhere; I don't
  need to know if the log shipped."
- **Background indexing.** Search-index update after a write succeeds.
- **Cache warm-up.** Prefetch related data so the next request is hot.

## The contract

| Behavior                       | What happens                                          |
|--------------------------------|-------------------------------------------------------|
| Parent stage completion        | Returns the moment `schedule()` returns (sync)        |
| Child execution                | Deferred to the driver's flush boundary (microtask)   |
| Errors in the child            | Land on the (discarded) handle — go silent            |
| Parent's narrative / metrics   | Unaffected — child runs in its own executor           |

If you need to surface child errors, attach an EmitRecorder or use
`$detachAndJoinLater` and `.wait().catch(...)` instead.

## The pattern

```typescript
import { microtaskBatchDriver } from 'footprintjs/detach';

.addFunction('ProcessOrder', async (scope) => {
  scope.orderId = await db.create(...);
  // Fire telemetry without blocking.
  scope.$detachAndForget(microtaskBatchDriver, telemetryChart, {
    event: 'order.processed',
    orderId: scope.orderId,
  });
})
```
