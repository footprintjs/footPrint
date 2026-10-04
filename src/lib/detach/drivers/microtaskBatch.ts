/**
 * detach/drivers/microtaskBatch.ts — Batch detached work into ONE microtask.
 *
 * Pattern:  Producer-consumer with batched flush — accumulate during
 *           the current sync slice, drain at the next microtask boundary.
 *           `batch.ts · createBatchSchedule` owns the lifecycle shared
 *           with the timeout and immediate-tick drivers.
 * Role:     The in-process driver the docs name (no driver is the default:
 *           every detach call passes one). One `queueMicrotask` per
 *           batch amortizes scheduling cost across its work items.
 *           Suitable for browser, Node and edge runtimes that provide
 *           `queueMicrotask`.
 *
 * Lifecycle:
 *
 *   schedule(child, input, refId)            ← driver entry
 *     └─ create handle (queued)
 *     └─ register in detachRegistry
 *     └─ push work item onto local queue
 *     └─ if this is a new batch → queueMicrotask(flush)
 *     └─ on scheduling failure → retire batch, fail + unregister handles
 *     └─ return handle (sync — passive recorder rule)
 *
 *   flush() (microtask)                       ← deferred
 *     └─ swap out queue (drain races safely)
 *     └─ for each item: _markRunning, await runChild, _markDone/_markFailed
 *     └─ unregister handle from detachRegistry
 *
 * Why microtask (and not setImmediate / setTimeout):
 *   - Microtasks start BEFORE returning to the event loop; an async
 *     child can still finish on a later tick
 *   - No timer delay or Node-only scheduling API is required
 *
 * Re-entrancy:
 *   - A flush retires its batch before starting children. If `runChild`
 *     calls `schedule()` for nested detach, it opens a fresh batch and
 *     schedules a new microtask.
 *   - A chain of n nested detaches needs n microtask boundaries
 */

import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver } from '../types.js';
import { createBatchSchedule } from './batch.js';

/**
 * Build a microtask-batch driver wired to a custom child runner. Most
 * consumers want the default singleton `microtaskBatchDriver` instead;
 * this factory exists for tests and for advanced consumers who want to
 * inject their own runner (e.g., a runner that wraps the child in a
 * tracing context).
 */
export function createMicrotaskBatchDriver(runChild: ChildRunner = defaultRunChild): DetachDriver {
  return {
    name: 'microtask-batch',
    capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
    schedule: createBatchSchedule((flush) => queueMicrotask(flush), runChild),
  };
}

/**
 * Ready-made singleton. Most consumers import this and pass it as the first
 * argument: `executor.detachAndJoinLater(microtaskBatchDriver, child, input)`.
 * It is not an implicit default — nothing picks a driver for you.
 */
export const microtaskBatchDriver: DetachDriver = createMicrotaskBatchDriver();
