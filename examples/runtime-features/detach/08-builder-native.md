---
name: Detach (Builder-Native)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#builder-native
---

# `addDetachAndForget` / `addDetachAndJoinLater` — Detach as a Chart Stage

When you want detach to be **explicit in the chart graph** (visible in
narrative, discoverable to introspection tools, drill-downable in
visualizations), use the builder-native composition. These methods are
sugar over `addFunction` — zero engine changes — but they make the
detach a first-class step.

```
seedFn ──► [DetachAndForget: telemetry] ──► nextFn
                       │
                       ▼ (driver schedules)
                  telemetryChart
```

vs. the inline call:
```
seedFn ──► [function "process"]               ──► nextFn
                       │
                       └── scope.$detachAndForget(...)
```

The graph view of the second one hides the detach inside `process`.
Builder-native makes it a labeled stop.

## When to use

- **Visualization matters.** You want the detach to show up in narrative
  / Mermaid diagrams / explainable UI as its own node.
- **Reusable side-effect chain.** Multiple charts share the same
  telemetry chart — you want the detach call site to read the same way
  every time.
- **Audit-visible side effects.** A reviewer scanning chart structure
  can spot every detach without reading stage bodies.

## addDetachAndForget — fire-and-forget as a stage

```typescript
import { microtaskBatchDriver } from 'footprintjs/detach';

flowChart<S>('process', processFn, 'process')
  .addDetachAndForget('telemetry', telemetryChart, {
    driver: microtaskBatchDriver,
    inputMapper: (scope) => ({ event: 'processed', orderId: scope.orderId }),
  })
  .addFunction('next', nextFn, 'next')
  .build();
```

## addDetachAndJoinLater — handle delivered to onHandle callback

The handle CANNOT live in shared state — `StageContext.setValue` calls
`structuredClone`, which drops the handle's class prototype (and with
it, the `.wait()` method). The builder method delivers the handle to
your `onHandle` callback — store it in a closure-local array and have
a downstream stage await `Promise.all`.

```typescript
const handles: DetachHandle[] = [];

flowChart<S>('seed', seedFn, 'seed')
  .addDetachAndJoinLater('eval-a', evalChart, {
    driver: microtaskBatchDriver,
    inputMapper: (scope) => scope.configA,
    onHandle: (h) => handles.push(h),
  })
  .addDetachAndJoinLater('eval-b', evalChart, {
    driver: microtaskBatchDriver,
    inputMapper: (scope) => scope.configB,
    onHandle: (h) => handles.push(h),
  })
  .addFunction('join', async (scope) => {
    const settled = await Promise.all(handles.map((h) => h.wait()));
    scope.results = settled.map((r) => r.result);
  }, 'join')
  .build();
```

> ⚠️  **Concurrency note:** putting `handles` in a module-level closure
> works for single-run scripts. For server code that runs the same
> chart concurrently across requests, allocate a new closure per run
> (e.g., wrap chart construction in a factory function) so handles
> from different runs don't bleed into each other.
