---
name: Detach (Bare Executor)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#bare-executor
---

# `executor.detachAndJoinLater` — From Outside Any Chart

When you have a `FlowChartExecutor` and want to fire side-effect children
**alongside** the main chart (without putting them inside it), use the
executor's bare-method entry point.

```
exec.detachAndForget(driver, sideChart, ...)   ◄─ before run
exec.run()                                      ◄─ main chart
exec.detachAndForget(driver, anotherChart, ...) ◄─ after run
```

## When to use

- **App-level orchestration** that fires several charts as parallel "side
  workers" coordinated by a thin host script.
- **Health-check pings** issued by a long-lived executor.
- **Cross-cutting workers** that don't belong to any one user-facing flow
  but share the executor's lifecycle.

## How refIds differ from the scope path

| Caller                          | refId prefix                       |
|---------------------------------|------------------------------------|
| `scope.$detachAndJoinLater`     | `<runtimeStageId>:detach:<n>`      |
| `executor.detachAndJoinLater`   | `__executor__:detach:<n>`          |

The synthetic `__executor__` prefix is honest about provenance — there is
no source stage to point back to.

## The pattern

```typescript
import { microtaskBatchDriver } from 'footprintjs/detach';

const exec = new FlowChartExecutor(mainChart);
const handle = exec.detachAndJoinLater(microtaskBatchDriver, healthCheckChart, undefined);
await exec.run();
const result = await handle.wait();
```
