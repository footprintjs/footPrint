/**
 * detach/drivers/immediate.ts — Run detached work synchronously inside `schedule()`.
 *
 * Pattern:  Null-object driver for the "no actual deferral" case. Same
 *           intent as a `setTimeout(fn, 0)` shim that just calls `fn()`
 *           — keeps the API surface uniform so consumers can swap drivers
 *           without changing call sites.
 * Role:     Test fixture + opt-in for consumers who want fire-and-forget
 *           ergonomics (the handle API) without actually deferring. Useful
 *           for:
 *
 *             - unit tests where deterministic, synchronous completion
 *               beats microtask gymnastics
 *             - very small detach payloads where the overhead of a
 *               microtask roundtrip exceeds the work itself
 *             - debugging — easier to step through with breakpoints
 *
 * Performance:
 *   - Sync runChild → handle becomes terminal before `schedule()` returns
 *   - Async runChild → handle marks running sync, terminal at runChild's
 *     resolution. The `wait()` Promise is the same one consumers use for
 *     any other driver; behaviour is uniform.
 *
 * Caveat — this is NOT a passive-recorder by default:
 *   When runChild is sync, the parent stage observes the work's side
 *   effects WITHIN its own slice. That's intentional for the test/debug
 *   use case but means consumers should NOT use `immediateDriver` for
 *   long-running work in production hot paths — pick `microtaskBatchDriver`
 *   for that.
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
