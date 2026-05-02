---
name: Detach (Error Handling)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#errors
---

# Detach Errors — Where They Land

A child flowchart that throws does **not** propagate to the parent. The
driver catches it (passive recorder rule) and routes it to the handle's
terminal `failed` state.

```
ChildChart throws ─► driver catch ─► handle.status = 'failed'
                                      handle.error  = <the Error>
                                      handle.wait() rejects with same Error
```

## Where it lands

| Caller pattern                     | How errors surface                              |
|------------------------------------|-------------------------------------------------|
| `detachAndJoinLater` + `wait()`    | Promise rejects with the captured `Error`       |
| `detachAndJoinLater`, never wait   | `handle.status === 'failed'` (poll to observe)  |
| `detachAndForget`                  | Silent — handle is discarded; no observer       |

For `detachAndForget`, wire an `EmitRecorder` if you need to surface
failures globally. Or — if you ever want to know — switch to
`detachAndJoinLater` and `.wait().catch(...)`.

## The pattern

```typescript
const handle = scope.$detachAndJoinLater(microtaskBatchDriver, riskyChart, payload);

// Option A: await + catch
try {
  await handle.wait();
} catch (e) {
  log.warn('child failed', e);
}

// Option B: poll status
if (handle.status === 'failed') {
  log.warn('child failed', handle.error);
}
```
