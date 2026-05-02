/**
 * detach/drivers/setTimeout.ts — Defer detached work via `setTimeout(..., delayMs)`.
 *
 * Pattern:  Producer-consumer batch flush; deferral mechanism is
 *           `setTimeout` with a configurable delay (default `0`).
 * Role:     Cross-runtime "next macrotask" driver. Works in browsers,
 *           Node.js, Deno, Cloudflare Workers, Bun, etc.
 *
 * When to pick this:
 *   - Consumer wants a SPECIFIC delay (e.g. "ship telemetry in 5
 *     seconds, batched") — pass `createSetTimeoutDriver({ delayMs: 5000 })`
 *   - Cross-runtime detach where `setImmediate` isn't available
 *   - Coalescing high-frequency events into a low-frequency flush
 *
 * Caveats:
 *   - Not for low-latency hot paths — minimum delay is ~4ms in
 *     browsers per the HTML5 spec, ~1ms in Node. Use
 *     `microtaskBatchDriver` for sub-ms scheduling.
 *   - Browser tab freezing / throttling can extend the delay
 *     significantly. Don't rely on precise timing.
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

export interface SetTimeoutDriverOptions {
  /** Milliseconds to wait before flushing the batch. Default 0
   *  (next macrotask). */
  readonly delayMs?: number;
  /** Custom `runChild`. Defaults to spawning a `FlowChartExecutor`. */
  readonly runChild?: ChildRunner;
}

export function createSetTimeoutDriver(opts: SetTimeoutDriverOptions = {}): DetachDriver {
  const delayMs = opts.delayMs ?? 0;
  const runChild = opts.runChild ?? defaultRunChild;
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
    name: delayMs === 0 ? 'set-timeout' : `set-timeout-${delayMs}ms`,
    capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
    schedule(child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      queue.push({ child, input, handle });
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, delayMs);
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

/** Default singleton — zero-delay (next macrotask). For configurable
 *  delays, use `createSetTimeoutDriver({ delayMs })`. */
export const setTimeoutDriver: DetachDriver = createSetTimeoutDriver();
