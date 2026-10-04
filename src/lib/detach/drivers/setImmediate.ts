/**
 * detach/drivers/setImmediate.ts — Defer detached work to a Node.js
 *                                  `setImmediate` boundary.
 *
 * Pattern:  Same producer-consumer batch flush as `microtaskBatch`,
 *           but the deferral is `setImmediate` instead of
 *           `queueMicrotask`. Yields control back to the event loop
 *           BEFORE running — allows pending I/O callbacks to drain
 *           first, which microtasks would block.
 * Role:     Node-specific driver for "fire-and-forget after the
 *           current I/O tick." Use when the parent stage handles
 *           latency-sensitive work and you don't want detached work
 *           to compete for the synchronous slice.
 *
 * When to pick this over microtaskBatch:
 *   - You're shipping logs / metrics in a hot HTTP path and don't
 *     want them blocking the response from being flushed
 *   - The detached work itself is CPU-heavy enough that running it on
 *     the same microtask cycle would delay other microtasks
 *   - You explicitly want "next event-loop tick" semantics — useful
 *     when interacting with third-party libraries that expect at
 *     least one I/O tick between schedule and execution
 *
 * Capability:
 *   - `nodeSafe: true` — relies on Node's `setImmediate`, NOT
 *     available in browsers / Deno / Cloudflare Workers (use
 *     `setTimeoutDriver` for cross-runtime alternative)
 */

import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver } from '../types.js';
import { createBatchSchedule } from './batch.js';

// Node-only global. We don't ship @types/node, so declare the minimal
// shape here. `setImmediateDriver` advertises `nodeSafe: true`.
// Both explicit preflight and scheduling check availability lazily,
// so importing this module does not require the Node-only global.
declare const setImmediate: ((cb: () => void) => unknown) | undefined;

export function createSetImmediateDriver(runChild: ChildRunner = defaultRunChild): DetachDriver {
  return {
    name: 'set-immediate',
    capabilities: { nodeSafe: true },
    validate(): void {
      scheduler();
    },
    schedule: createBatchSchedule((flush) => scheduler()(flush), runChild),
  };
}

function scheduler(): (cb: () => void) => unknown {
  if (typeof setImmediate !== 'function') {
    throw new Error(
      '[detach] setImmediateDriver requires Node.js — global `setImmediate` is not defined ' +
        'in this runtime. Use `microtaskBatchDriver` for cross-runtime use, or `setTimeoutDriver` ' +
        'for browser/edge environments.',
    );
  }
  return setImmediate;
}

export const setImmediateDriver: DetachDriver = createSetImmediateDriver();
