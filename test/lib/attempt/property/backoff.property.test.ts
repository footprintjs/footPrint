/**
 * The backoff builders — PROPERTY test.
 *
 * Over random schedules, attempt numbers, random draws, stated waits and caps:
 *
 *   1. every wait is a finite number >= 0 drawn under the ceiling c = min(maxDelayMs, baseDelayMs × multiplier^(n − 1))
 *      — the cap BEFORE the draw (no `maxDelayMs`: `Number.MAX_SAFE_INTEGER`) — exactly as declared ('none' = c,
 *      'equal' = c/2 + r·c/2, 'full' = r·c), so it lies in its band: 'equal' ∈ [c/2, c], 'full' ∈ [0, c];
 *   2. the ceilings never shrink from one attempt to the next;
 *   3. read as the runner reads a backoff (`resolveBackoffMs`, then `cappedWaitMs`), a wait never exceeds the
 *      policy's `maxBackoffMs` — the cap stays the policy's;
 *   4. `statedWaitFirst` answers the stated wait exactly when it is a finite number >= 0, else the schedule's;
 *   5. on the runner (virtual clock), every recorded `delayMs` is at most `maxBackoffMs`, and the timers the series
 *      arms are exactly the recorded waits — the record explains every wait without redrawing it.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackoffJitter } from '../../../../src/lib/attempt/backoff.js';
import { exponentialBackoff, statedWaitFirst } from '../../../../src/lib/attempt/backoff.js';
import { cappedWaitMs } from '../../../../src/lib/attempt/policy.js';
import { resolveBackoffMs, runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord } from '../../../../src/lib/attempt/types.js';

const jitter = fc.constantFrom<BackoffJitter>('none', 'equal', 'full');
/** A schedule, with a `maxDelayMs` (>= its base) about half the time. */
const spec = fc
  .record({
    baseDelayMs: fc.double({ min: 0, max: 1e6, noNaN: true }),
    multiplier: fc.double({ min: 1, max: 8, noNaN: true }),
    jitter,
  })
  .chain((s) =>
    fc
      .option(fc.double({ min: s.baseDelayMs, max: s.baseDelayMs + 1e6, noNaN: true }), { nil: undefined })
      .map((maxDelayMs) => ({ ...s, maxDelayMs })),
  );
const attempt = fc.integer({ min: 1, max: 80 });
const draw = fc.double({ min: 0, max: 1, noNaN: true });

/** The ceiling, computed apart from the implementation (same power, so the same floating-point rounding). */
const ceiling = (base: number, multiplier: number, n: number, maxDelayMs = Number.MAX_SAFE_INTEGER) =>
  base === 0 ? 0 : Math.min(base * multiplier ** (n - 1), maxDelayMs);

describe('exponentialBackoff — properties', () => {
  it('every wait is drawn under the capped ceiling exactly as declared, and lies inside its band', () => {
    fc.assert(
      fc.property(spec, attempt, draw, (s, n, r) => {
        const wait = exponentialBackoff({ ...s, random: () => r })(n);
        const c = ceiling(s.baseDelayMs, s.multiplier, n, s.maxDelayMs);
        const declared = s.jitter === 'none' ? c : s.jitter === 'equal' ? Math.min(c, c / 2 + (r * c) / 2) : r * c;
        expect(wait).toBe(declared);
        expect(Number.isFinite(wait)).toBe(true);
        expect(wait).toBeGreaterThanOrEqual(s.jitter === 'equal' ? c / 2 : 0);
        expect(wait).toBeLessThanOrEqual(c);
      }),
    );
  });

  it('the ceilings never shrink from one attempt to the next (up to the rounding of the power)', () => {
    fc.assert(
      fc.property(spec, attempt, (s, n) => {
        const backoff = exponentialBackoff({ ...s, jitter: 'none' });
        expect(backoff(n + 1)).toBeGreaterThanOrEqual(backoff(n) * (1 - 1e-12));
      }),
    );
  });

  it("read as the runner reads it, a wait never exceeds the policy's maxBackoffMs", () => {
    fc.assert(
      fc.property(spec, attempt, draw, fc.double({ min: 0, max: 1e7, noNaN: true }), (s, n, r, max) => {
        const backoff = exponentialBackoff({ ...s, random: () => r });
        const waited = cappedWaitMs(resolveBackoffMs(backoff, n), max);
        expect(waited).toBeGreaterThanOrEqual(0);
        expect(waited).toBeLessThanOrEqual(max);
      }),
    );
  });
});

describe('statedWaitFirst — properties', () => {
  const stated = fc.oneof(
    fc.double(),
    fc.integer(),
    fc.constant(undefined),
    fc.constant(null),
    fc.string({ maxLength: 4 }),
    fc.constant(Number.POSITIVE_INFINITY),
  );

  it('answers the stated wait exactly when it is a finite number >= 0, else the schedule', () => {
    fc.assert(
      fc.property(stated, attempt, (value, n) => {
        const schedule = exponentialBackoff({ baseDelayMs: 10 });
        const wait = statedWaitFirst(() => value as number, schedule)(n, new Error('busy'));
        const honoured = typeof value === 'number' && Number.isFinite(value) && value >= 0;
        expect(wait).toBe(honoured ? value : schedule(n));
      }),
    );
  });
});

describe('on the runner — properties', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('every recorded wait is at most maxBackoffMs, and the series waits exactly what the records say', async () => {
    await fc.assert(
      fc.asyncProperty(
        spec,
        fc.array(draw, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        fc.double({ min: 0, max: 5_000, noNaN: true }),
        async (s, draws, attempts, fails, maxBackoffMs) => {
          let i = 0;
          const random = () => draws[i++ % draws.length];
          const records: AttemptRecord[] = [];
          const timers = vi.spyOn(globalThis, 'setTimeout');
          const done = runAttempts(
            (n) => (n <= fails ? Promise.reject(new Error('busy')) : Promise.resolve('ok')),
            {
              attempts,
              backoffMs: exponentialBackoff({ ...s, baseDelayMs: s.baseDelayMs % 2_000, random }),
              maxBackoffMs,
            },
            { series: 's#0', onAttempt: (r) => records.push(r) },
          ).catch(() => 'failed');
          await vi.runAllTimersAsync();
          await done;
          const armed = timers.mock.calls.map(([, ms]) => ms);
          timers.mockRestore();
          const waits = records.flatMap((r) => (r.next === 'retry' ? [r.delayMs ?? 0] : []));
          for (const wait of waits) expect(wait).toBeLessThanOrEqual(maxBackoffMs);
          // No deadline and no cap: the only timers are the waits, armed for exactly the recorded milliseconds.
          expect(armed).toEqual(waits.filter((wait) => wait > 0));
        },
      ),
      { numRuns: 60 },
    );
  });
});
