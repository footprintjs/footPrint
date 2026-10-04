/**
 * One lifecycle for the three deferred batching drivers. Adapters supply
 * the deferral mechanism; this module owns each batch from registration
 * through dispatch or refusal, and each child's terminal cleanup.
 * Internal only: the consumer contract remains `types.ts · DetachDriver`.
 */

import type { FlowChart } from '../../builder/types.js';
import { extractErrorInfo } from '../../errors/errorInfo.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import type { ChildRunner } from '../runChild.js';
import type { DetachDriver, DetachHandle } from '../types.js';

interface WorkItem {
  readonly child: FlowChart;
  readonly input: unknown;
  readonly handle: DetachHandle;
}

export function createBatchSchedule(
  defer: (flush: () => void) => void,
  runChild: ChildRunner,
): DetachDriver['schedule'] {
  let pending: WorkItem[] | undefined;

  // Taking a batch retires its callback and releases its captured inputs.
  // A callback captured by a scheduler that then threw must never take
  // a newer batch. Retire BEFORE children/error formatting can re-enter.
  function take(batch: WorkItem[]): WorkItem[] {
    if (pending !== batch) return [];
    pending = undefined;
    return batch.splice(0);
  }

  return (child, input, refId) => {
    const handle = createHandle(refId);
    register(handle);
    const item = { child, input, handle };
    if (pending) {
      pending.push(item);
      return handle;
    }

    const batch = [item];
    pending = batch;
    try {
      defer(() => {
        // Start siblings in order without awaiting them. Reentrant
        // scheduling belongs to a fresh batch with its own callback.
        for (const work of take(batch)) {
          executeOne(work, runChild).then(undefined, undefined);
        }
      });
    } catch (error) {
      const refused = take(batch);
      if (refused.length > 0) {
        const failure = asError(error);
        for (const work of refused) {
          asImpl(work.handle)._markFailed(failure);
          unregister(work.handle.id);
        }
      }
    }
    return handle;
  };
}

async function executeOne(item: WorkItem, runChild: ChildRunner): Promise<void> {
  const impl = asImpl(item.handle);
  impl._markRunning();
  try {
    impl._markDone(await runChild(item.child, item.input));
  } catch (error) {
    impl._markFailed(asError(error));
  } finally {
    unregister(impl.id);
  }
}

function asError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
    return new Error(extractErrorInfo(error).message);
  } catch {
    // Even classification can invoke user code (for example a revoked
    // or stateful Proxy). Describing a refusal must not prevent it from
    // settling the handle. Do not inspect the thrown value again here.
    return new Error('Detached work failed; its thrown value could not be described.');
  }
}
