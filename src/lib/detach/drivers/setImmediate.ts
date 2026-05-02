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

import type { FlowChart } from '../../builder/types.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver, DetachHandle } from '../types.js';

// Node-only global. We don't ship @types/node, so declare the minimal
// shape here. `setImmediateDriver` advertises `nodeSafe: true` and
// `validate()` throws helpfully if `setImmediate` is undefined at use
// time (e.g., browser bundle).
declare const setImmediate: ((cb: () => void) => unknown) | undefined;

interface WorkItem {
  readonly child: FlowChart;
  readonly input: unknown;
  readonly handle: DetachHandle;
}

export function createSetImmediateDriver(runChild: ChildRunner = defaultRunChild): DetachDriver {
  const queue: WorkItem[] = [];
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    const items = queue.splice(0);
    for (const item of items) {
      executeOne(item, runChild).then(undefined, undefined);
    }
  }

  return {
    name: 'set-immediate',
    capabilities: { nodeSafe: true },
    validate(): void {
      if (typeof setImmediate !== 'function') {
        throw new Error(
          '[detach] setImmediateDriver requires Node.js — global `setImmediate` is not defined ' +
            'in this runtime. Use `microtaskBatchDriver` for cross-runtime use, or `setTimeoutDriver` ' +
            'for browser/edge environments.',
        );
      }
    },
    schedule(child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      queue.push({ child, input, handle });
      if (!scheduled) {
        scheduled = true;
        // `setImmediate` is non-undefined here in Node; runtime guard
        // is in `validate()`. The `!` is a deliberate assertion.
        setImmediate!(flush);
      }
      return handle;
    },
  };
}

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

export const setImmediateDriver: DetachDriver = createSetImmediateDriver();
