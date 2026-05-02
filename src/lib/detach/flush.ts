/**
 * detach/flush.ts — Drain every in-flight detached handle to terminal.
 *
 * Pattern:  Drain-loop with deadline. Same shape as a graceful HTTP
 *           server shutdown: snapshot the queue, await everything in
 *           flight, repeat until empty or deadline.
 * Role:     Graceful-shutdown hook for consumers who launched
 *           fire-and-forget work and want to make sure it actually
 *           flushed before exiting (server stop, test cleanup, etc.).
 *
 * Why iterate (not single Promise.all over a snapshot):
 *   - A child stage can itself call `detachAndForget` while running —
 *     new handles arrive WHILE we're flushing. A single snapshot would
 *     miss them. Looping until `size() === 0` drains transitively.
 *
 * Why dedupe via `seen` Set:
 *   - Handles already terminal (but not yet `unregister`ed by their
 *     driver's finally-block) can re-appear in subsequent snapshots.
 *     Without dedupe, the `done` counter would double-count them.
 *
 * Why `Promise.allSettled` (not `Promise.all`):
 *   - One handle's rejection must NOT abort the rest. A failed child
 *     is normal (it's why `wait()` rejects); we still want to drain
 *     the siblings.
 */

import { ids, lookup, size } from './registry.js';
import type { DetachHandle } from './types.js';

export interface FlushResult {
  /** Handles whose `wait()` we EXPLICITLY awaited and saw fulfilled.
   *  Best-effort count — a child that completes inside another's
   *  `wait()` may finish (and unregister) before we get a chance to
   *  await it directly. The DRAIN is still guaranteed (registry empty
   *  on return); only the COUNT is approximate. */
  readonly done: number;
  /** Handles whose `wait()` rejected. Same best-effort semantics. */
  readonly failed: number;
  /** Handles still in-flight when the deadline expired. `0` indicates
   *  a successful (complete) drain — registry was empty on return. */
  readonly pending: number;
}

export interface FlushOptions {
  /** Max wall-clock to spend draining, in milliseconds. Default 30s. */
  readonly timeoutMs?: number;
}

/**
 * Wait for every in-flight detached handle to reach a terminal state.
 * Returns counts for diagnostics. PROCESS-WIDE — drains every driver
 * across every executor. For per-executor scoping, consumers should
 * collect their own handles from `executor.detachAndJoinLater(...)`
 * calls and await `Promise.allSettled([...].map(h => h.wait()))`
 * themselves.
 *
 * @example Graceful server shutdown
 * ```typescript
 * import { flushAllDetached } from 'footprintjs/detach';
 *
 * process.on('SIGTERM', async () => {
 *   const stats = await flushAllDetached({ timeoutMs: 10_000 });
 *   console.log(`Drained ${stats.done} done, ${stats.failed} failed, ${stats.pending} pending.`);
 *   process.exit(stats.pending === 0 ? 0 : 1);
 * });
 * ```
 */
export async function flushAllDetached(opts?: FlushOptions): Promise<FlushResult> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const seen = new Set<string>();
  let done = 0;
  let failed = 0;

  while (size() > 0) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return { done, failed, pending: size() };

    // Snapshot of NEW (unseen) handles. Existing terminal-but-still-
    // registered handles re-appear in subsequent snapshots; the seen
    // set prevents double-counting.
    const newIds = ids().filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      // Everything in the registry is already awaited — yield once and
      // re-check. The driver's unregister-in-finally hasn't run yet.
      await Promise.resolve();
      continue;
    }
    for (const id of newIds) seen.add(id);

    const handles = newIds.map((id) => lookup(id)).filter((h): h is DetachHandle => h !== undefined);

    // Race the drain against the per-iteration timeout. We use a
    // `'timeout'` sentinel on the timeout side so the type narrows.
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'__detach_timeout__'>((resolve) => {
      timerId = setTimeout(() => resolve('__detach_timeout__'), remainingMs);
    });
    const drainPromise = Promise.allSettled(handles.map((h) => h.wait()));
    const result = await Promise.race([drainPromise, timeoutPromise]);
    if (timerId !== undefined) clearTimeout(timerId);

    if (result === '__detach_timeout__') {
      return { done, failed, pending: size() };
    }
    for (const r of result) {
      if (r.status === 'fulfilled') done++;
      else failed++;
    }
  }

  return { done, failed, pending: 0 };
}
