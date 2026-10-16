/**
 * The deadline invariant — PROPERTY test (design §10, P1b).
 *
 * Over random ceilings, per-attempt durations, failure patterns, backoffs, attempt caps and budgets, on a virtual
 * clock (fake timers drive both the runner's waits and `Date.now`):
 *
 *   1. no attempt STARTS at or after the deadline;
 *   2. no backoff ends past it — every retry was decided with its wait inside the time left;
 *   3. no attempt runs past its cap — `durationMs ≤ timeoutMs` whenever the record has one;
 *   4. the series invariant still holds — at most `attempts` records, exactly one that does not retry, and it is
 *      the last.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptContext, AttemptRecord } from '../../../../src/lib/attempt/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** An attempt that takes `ms` (virtual), honours its signal, then fails or answers. */
function attemptTaking(ms: number, fails: boolean, t: AttemptContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (fails ? reject(new Error('busy')) : resolve('ok')), ms);
    t.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(t.signal.reason);
    });
  });
}

describe('the deadline invariant', () => {
  it('no attempt starts at or past the deadline, no wait ends past it, no attempt outlives its cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.record({ ms: fc.integer({ min: 0, max: 400 }), fails: fc.boolean() }), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 500 }),
        fc.option(fc.integer({ min: 1, max: 300 }), { nil: undefined }),
        fc.integer({ min: 1, max: 2_000 }),
        async (attempts, plan, backoffMs, timeoutMs, budget) => {
          const t0 = Date.now();
          const deadline = t0 + budget;
          const records: AttemptRecord[] = [];
          const done = runAttempts(
            (n, t) => attemptTaking(plan[n - 1].ms, plan[n - 1].fails, t),
            { attempts, backoffMs, ...(timeoutMs !== undefined && { timeoutMs }) },
            { series: 's#0', deadline, onAttempt: (r) => records.push(r) },
          ).catch(() => undefined);
          await vi.runAllTimersAsync();
          await done;

          expect(records.length).toBeGreaterThanOrEqual(1);
          expect(records.length).toBeLessThanOrEqual(attempts);
          for (const r of records) {
            expect(r.startedAt).toBeLessThan(deadline);
            if (r.timeoutMs !== undefined) expect(r.durationMs).toBeLessThanOrEqual(r.timeoutMs);
          }
          for (const r of records.slice(0, -1)) {
            expect(r.next).toBe('retry');
            expect(r.startedAt + r.durationMs + (r.delayMs ?? 0)).toBeLessThan(deadline);
          }
          expect(records.at(-1)!.next).not.toBe('retry');
        },
      ),
      { numRuns: 150 },
    );
  });
});
