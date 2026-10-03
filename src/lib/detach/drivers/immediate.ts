/**
 * detach/drivers/immediate.ts — Start detached work at once: no batch, no timer.
 *
 * Pattern:  The thinnest driver. `schedule()` registers the handle, marks it
 *           `running` SYNCHRONOUSLY and starts `runChild` on the next
 *           microtask (`Promise.resolve().then(...)`) — one microtask per
 *           call, nothing shared with other calls. It keeps the API surface
 *           uniform so consumers can swap drivers without changing call sites.
 * Role:     Test fixture + opt-in for consumers who want the handle API
 *           without a queue to flush. Useful for:
 *
 *             - unit tests where a handle that reads `running` the moment
 *               `schedule()` returns beats waiting for a batch flush
 *             - very small detach payloads where batching buys nothing
 *             - debugging — fewer moving parts to step through
 *
 * What is synchronous, and what is not (test/lib/detach/immediate.test.ts, P1, pins the `running` status):
 *   - SYNC:  the registry entry exists and `_markRunning()` has run before
 *            `schedule()` returns, so the handle reads `running`.
 *   - LATER: `runChild` is called on the next microtask EVEN when it is a
 *            sync function, and the handle becomes terminal only after the
 *            returned promise settles. The `wait()` Promise is the same one
 *            consumers use for any other driver; behaviour is uniform.
 *
 * Caveat — this does NOT run the work inside the parent's slice:
 *   The child starts once the parent's current synchronous code has
 *   finished, but it is neither batched nor deferred beyond that one
 *   microtask, so it can interleave with the parent's next `await`. For
 *   work that should leave the hot path as a single batch, pick
 *   `microtaskBatchDriver`.
 */

import type { FlowChart } from '../../builder/types.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver, DetachHandle } from '../types.js';

/**
 * Build an immediate driver wired to a custom child runner. Most
 * consumers want the default singleton `immediateDriver`.
 */
export function createImmediateDriver(runChild: ChildRunner = defaultRunChild): DetachDriver {
  return {
    name: 'immediate',
    capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
    schedule(child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      const impl = asImpl(handle);
      impl._markRunning();
      // Don't await here — driver schedule() must return synchronously
      // (passive recorder rule). The Promise from runChild handles the
      // rest; if it's already-resolved (sync runner), the .then runs on
      // the next microtask but the schedule() call still returns sync.
      Promise.resolve()
        .then(() => runChild(child, input))
        .then(
          (result) => {
            impl._markDone(result);
            unregister(impl.id);
          },
          (err: unknown) => {
            impl._markFailed(err instanceof Error ? err : new Error(String(err)));
            unregister(impl.id);
          },
        );
      return handle;
    },
  };
}

/** Default singleton — most consumers use this. */
export const immediateDriver: DetachDriver = createImmediateDriver();
