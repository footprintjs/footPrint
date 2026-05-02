/**
 * detach/drivers/microtaskBatch.ts — Batch detached work into ONE microtask.
 *
 * Pattern:  Producer-consumer with batched flush. Same shape as
 *           agentfootprint's `EventDispatcher` flush queue and the React
 *           reconciler's microtask scheduling — accumulate during the
 *           current sync slice, drain at the next microtask boundary.
 * Role:     Default driver for in-process detach. Cheapest scheduling
 *           primitive on V8/JSC: one `queueMicrotask` per batch
 *           regardless of how many work items, so the perf budget
 *           amortizes. Suitable for browser AND node AND edge runtimes
 *           (queueMicrotask is universal since 2018).
 *
 * Lifecycle:
 *
 *   schedule(child, input, refId)            ← driver entry
 *     └─ create handle (queued)
 *     └─ register in detachRegistry
 *     └─ push work item onto local queue
 *     └─ if no microtask scheduled yet → queueMicrotask(flush)
 *     └─ return handle (sync — passive recorder rule)
 *
 *   flush() (microtask)                       ← deferred
 *     └─ swap out queue (drain races safely)
 *     └─ for each item: _markRunning, await runChild, _markDone/_markFailed
 *     └─ unregister handle from detachRegistry
 *
 * Why microtask (and not setImmediate / setTimeout):
 *   - Microtasks run BEFORE returning to the event loop — guarantees
 *     the work finishes within the current "tick" if the runtime allows
 *   - Lowest possible deferral cost (~50ns on modern V8)
 *   - Works in EVERY JS runtime (browser, node, deno, bun, edge)
 *   - Doesn't require any timer infrastructure → no GC pressure
 *
 * Re-entrancy:
 *   - If `runChild` calls `schedule()` for nested detach, the new item
 *     lands on the SAME queue. Because `scheduled` flips back to false
 *     at the start of `flush`, the new item triggers a fresh microtask.
 *   - Worst-case: O(n) microtasks for n nested levels. Acceptable —
 *     real-world detach trees are shallow.
 */

import type { FlowChart } from '../../builder/types.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver, DetachHandle } from '../types.js';

interface WorkItem {
  readonly child: FlowChart;
  readonly input: unknown;
  readonly handle: DetachHandle;
}

/**
 * Build a microtask-batch driver wired to a custom child runner. Most
 * consumers want the default singleton `microtaskBatchDriver` instead;
 * this factory exists for tests and for advanced consumers who want to
 * inject their own runner (e.g., a runner that wraps the child in a
 * tracing context).
 */
export function createMicrotaskBatchDriver(runChild: ChildRunner = defaultRunChild): DetachDriver {
  // Per-driver-instance queue and flush guard. Closed over by `schedule`
  // and `flush` so each call to `createMicrotaskBatchDriver` gets its
  // own isolated batch (test isolation, multi-tenant scenarios).
  const queue: WorkItem[] = [];
  let scheduled = false;

  function flush(): void {
    // Reset BEFORE draining so re-entrant schedule()s during runChild
    // queue a fresh microtask instead of joining the in-flight drain.
    scheduled = false;
    const items = queue.splice(0);
    for (const item of items) {
      // Each item runs concurrently — no awaits here, so the outer
      // for-loop completes within this microtask. Errors inside
      // `executeOne` are routed to the handle, not thrown. The promise
      // is intentionally not awaited; ignore-promise-returned via the
      // explicit no-op .then() pattern that the project's lint config
      // accepts (vs `void`, which `no-void` rejects).
      executeOne(item, runChild).then(undefined, undefined);
    }
  }

  return {
    name: 'microtask-batch',
    capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
    schedule(child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      queue.push({ child, input, handle });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
      return handle;
    },
  };
}

/**
 * Per-item execution. Marks the handle running, awaits the runner,
 * routes outcome to the handle, cleans up the registry entry. Never
 * throws — errors land on the handle (passive recorder rule).
 */
async function executeOne(item: WorkItem, runChild: ChildRunner): Promise<void> {
  const impl = asImpl(item.handle);
  impl._markRunning();
  try {
    const result = await runChild(item.child, item.input);
    impl._markDone(result);
  } catch (err) {
    impl._markFailed(err instanceof Error ? err : new Error(String(err)));
  } finally {
    unregister(impl.id);
  }
}

/**
 * Default singleton. Most consumers import this and pass it to
 * `executor.detachAndJoinLater(child, input, { driver: microtaskBatchDriver })`
 * (or rely on it being the executor's default driver, set in T5b).
 */
export const microtaskBatchDriver: DetachDriver = createMicrotaskBatchDriver();
