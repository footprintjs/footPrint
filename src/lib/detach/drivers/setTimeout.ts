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

import { setLongTimeout } from '../../timers/longTimeout.js';
import { type ChildRunner, defaultRunChild } from '../runChild.js';
import type { DetachDriver } from '../types.js';
import { createBatchSchedule } from './batch.js';

export interface SetTimeoutDriverOptions {
  /** Milliseconds to wait before flushing the batch — a finite number.
   *  Default 0 (next macrotask); a negative delay waits nothing, as the
   *  host timer does. A delay past 2^31 − 1 ms is waited in full (the one
   *  long-timer law, `timers/longTimeout.ts`), never cut to 1 ms. */
  readonly delayMs?: number;
  /** Custom `runChild`. Defaults to spawning a `FlowChartExecutor`. */
  readonly runChild?: ChildRunner;
}

export function createSetTimeoutDriver(opts: SetTimeoutDriverOptions = {}): DetachDriver {
  const delayMs = opts.delayMs ?? 0;
  // `Infinity` would never flush the batch (a silent hang) and `NaN` names no delay: refused when the driver is made.
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
    throw new RangeError(
      `createSetTimeoutDriver: delayMs must be a finite number of milliseconds (got ${
        typeof delayMs === 'number' ? String(delayMs) : typeof delayMs
      })`,
    );
  }
  const runChild = opts.runChild ?? defaultRunChild;
  return {
    name: delayMs === 0 ? 'set-timeout' : `set-timeout-${delayMs}ms`,
    capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
    schedule: createBatchSchedule((flush) => {
      setLongTimeout(flush, delayMs);
    }, runChild),
  };
}

/** Default singleton — zero-delay (next macrotask). For configurable
 *  delays, use `createSetTimeoutDriver({ delayMs })`. */
export const setTimeoutDriver: DetachDriver = createSetTimeoutDriver();
