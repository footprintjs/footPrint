---
name: Detach (Immediate Driver)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#immediate
---

# `immediateDriver` — Deterministic Detach for Tests

The `immediateDriver` runs the child's runner inside `schedule()` itself
(via `Promise.resolve().then(...)`). The handle transitions to `running`
synchronously and is terminal as soon as the runner resolves. No microtask
batching, no scheduling lag.

## When to use

- **Tests.** Snap detach lifecycle into known points without managing
  microtask draining.
- **Tiny payloads** where the microtask roundtrip cost would dominate.
- **Debugging.** Easier to step through with a debugger because no
  deferral happens.

## Caveats

- **Status sequence telescopes.** Consumers polling `.status`
  synchronously after `schedule()` see `running`, never `queued`.
- **NOT a passive recorder.** When the runner is sync, side effects
  observe inside the parent's slice. Pick `microtaskBatchDriver` for
  long-running production work.

## The pattern

```typescript
import { immediateDriver } from 'footprintjs/detach';

it('records the metric immediately', () => {
  const handle = scope.$detachAndJoinLater(immediateDriver, recordMetric, payload);
  expect(handle.status).toBe('running'); // not 'queued'
  await handle.wait();
  expect(handle.status).toBe('done');
});
```
