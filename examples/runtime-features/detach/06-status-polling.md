---
name: Detach (Status Polling)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#status
---

# `handle.status` — Sync Inspection Without `await`

The handle is intentionally **not** Promise-shaped. Reading `handle.status`
is a plain property access — cheap, sync, no allocation. Use it for
status indicators / progress UIs / "are we still in flight?" gates that
shouldn't depend on async.

```
handle.status   ∈   'queued' | 'running' | 'done' | 'failed'
```

## When to use

- **Status banners.** Render "still working…" / "done" / "failed" without
  thread-jumping.
- **Backpressure check.** "Don't fire another detach if we have ≥10 in
  flight" — count handles where `.status` is `queued | running`.
- **Cancellation gates.** "If user clicked cancel, just stop polling and
  let the in-flight handles finish silently."

## The contract

| Property      | Read pattern                                        |
|---------------|-----------------------------------------------------|
| `handle.status` | Sync property; transitions are one-way + irreversible |
| `handle.result` | Sync — `undefined` until `status === 'done'`      |
| `handle.error`  | Sync — `undefined` until `status === 'failed'`    |
| `handle.wait()` | Returns SAME cached Promise on repeated calls     |

## The pattern

```typescript
const handle = scope.$detachAndJoinLater(microtaskBatchDriver, child, input);

// Poll status without await.
function inFlight(handles: DetachHandle[]): number {
  return handles.filter((h) => h.status === 'queued' || h.status === 'running').length;
}

// At any time:
if (inFlight(allHandles) >= 10) console.log('over backpressure budget');
```
