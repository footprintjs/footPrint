/**
 * `exponentialBackoff` / `statedWaitFirst` — deterministic builders of the function `RetryPolicy.backoffMs` takes.
 *
 * WHY: every retry loop needs an exponential ceiling and some jitter, and every hand copy drifts. These build the
 * policy's existing function, so the runner keeps its one law: it caps the answer at `maxBackoffMs`, stops a wait
 * that would outlast the deadline (`no-time-left`), and records the wait it chose — nothing is redrawn to explain it.
 *
 * Test types: Unit (the ceiling and its growth; the defaults; the exact bounds of each jitter at r = 0 and r → 1; a
 * stated wait wins) · Boundary (refusals naming the field; a random source outside [0, 1]; saturation; how an attempt
 * number is read; a malformed or throwing stated wait falls back to the schedule) · Scenario (on the runner: the
 * record and `onRetry` carry the drawn wait, `maxBackoffMs` caps it, a stated wait past the deadline stops the
 * series `no-time-left`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exponentialBackoff, statedWaitFirst } from '../../../../src/lib/attempt/backoff.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord } from '../../../../src/lib/attempt/types.js';

/** A random source that always answers `r`. */
const fixed = (r: number) => () => r;
/** A random source that answers `values` in turn. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};
/** r → 1, from below. */
const ALMOST_ONE = 1 - 1e-9;

describe('exponentialBackoff — the ceiling', () => {
  it("'none' waits the ceiling baseDelayMs × multiplier^(n − 1) and never asks the random source", () => {
    const random = vi.fn(() => 0.5);
    const backoff = exponentialBackoff({ baseDelayMs: 100, multiplier: 3, jitter: 'none', random });
    expect([1, 2, 3, 4].map((n) => backoff(n))).toEqual([100, 300, 900, 2_700]);
    expect(random).not.toHaveBeenCalled();
  });

  it('the multiplier defaults to 2 and the jitter to none', () => {
    const backoff = exponentialBackoff({ baseDelayMs: 50 });
    expect([1, 2, 3, 4].map((n) => backoff(n))).toEqual([50, 100, 200, 400]);
  });

  it('a multiplier of 1 is a fixed wait; a base of 0 never waits', () => {
    expect([1, 5, 50].map((n) => exponentialBackoff({ baseDelayMs: 75, multiplier: 1 })(n))).toEqual([75, 75, 75]);
    expect([1, 5, 5_000].map((n) => exponentialBackoff({ baseDelayMs: 0, multiplier: 10 })(n))).toEqual([0, 0, 0]);
  });

  it('it ignores the error: the same attempt always has the same ceiling', () => {
    const backoff = exponentialBackoff({ baseDelayMs: 10 });
    expect(backoff(3, new Error('a'))).toBe(backoff(3, { retryAfterMs: 9_999 }));
  });
});

describe('exponentialBackoff — the exact bounds of each jitter (ceiling of attempt 3 = 400)', () => {
  const at = (jitter: 'equal' | 'full', r: number) =>
    exponentialBackoff({ baseDelayMs: 100, jitter, random: fixed(r) })(3);

  it("'equal' is c/2 at r = 0, c/2 + r·c/2 between, and approaches c as r → 1", () => {
    expect(at('equal', 0)).toBe(200);
    expect(at('equal', 0.5)).toBe(300);
    expect(at('equal', ALMOST_ONE)).toBeLessThan(400);
    expect(at('equal', ALMOST_ONE)).toBeGreaterThan(399.999);
  });

  it("'full' is 0 at r = 0, r·c between, and approaches c as r → 1", () => {
    expect(at('full', 0)).toBe(0);
    expect(at('full', 0.25)).toBe(100);
    expect(at('full', ALMOST_ONE)).toBeLessThan(400);
    expect(at('full', ALMOST_ONE)).toBeGreaterThan(399.999);
  });

  it('r = 1 lands on the ceiling, never above it', () => {
    expect(at('equal', 1)).toBe(400);
    expect(at('full', 1)).toBe(400);
  });

  it("'equal' stays under a subnormal ceiling, where halving rounds up", () => {
    const c = 15 * Number.MIN_VALUE; // c/2 + r·c/2 rounds to 16 units of Number.MIN_VALUE here
    expect(exponentialBackoff({ baseDelayMs: c, jitter: 'equal', random: fixed(ALMOST_ONE) })(1)).toBe(c);
  });

  it('each wait draws once, in attempt order', () => {
    const backoff = exponentialBackoff({ baseDelayMs: 100, jitter: 'full', random: sequence(0.5, 0.25, 1) });
    expect([1, 2, 3].map((n) => backoff(n))).toEqual([50, 50, 400]);
  });
});

describe('exponentialBackoff — boundaries', () => {
  it.each([
    [{ baseDelayMs: -1 }, RangeError, /exponentialBackoff: baseDelayMs must be a finite number >= 0 \(got -1\)/],
    [{ baseDelayMs: Number.NaN }, RangeError, /baseDelayMs must be a finite number >= 0 \(got NaN\)/],
    [{ baseDelayMs: Number.POSITIVE_INFINITY }, RangeError, /baseDelayMs .*\(got Infinity\)/],
    [{ baseDelayMs: '100' }, TypeError, /baseDelayMs .*\(got "100"\)/],
    [{ baseDelayMs: 10, multiplier: 0.5 }, RangeError, /multiplier must be a finite number >= 1 \(got 0\.5\)/],
    [{ baseDelayMs: 10, multiplier: Number.POSITIVE_INFINITY }, RangeError, /multiplier .*\(got Infinity\)/],
    [{ baseDelayMs: 10, multiplier: null }, TypeError, /multiplier .*\(got null\)/],
    [{ baseDelayMs: 10, jitter: 'half' }, RangeError, /jitter must be 'none', 'equal' or 'full' \(got "half"\)/],
    [{ baseDelayMs: 10, random: 0.5 }, TypeError, /random must be a function answering in \[0, 1\] \(got 0\.5\)/],
  ])('refuses %o, naming the field', (spec, kind, message) => {
    expect(() => exponentialBackoff(spec as never)).toThrow(kind);
    expect(() => exponentialBackoff(spec as never)).toThrow(message);
  });

  it('refuses a spec that is not an object', () => {
    expect(() => exponentialBackoff(null as never)).toThrow(/the spec must be an object .*\(got null\)/);
    expect(() => exponentialBackoff(250 as never)).toThrow(TypeError);
  });

  it.each([1.5, -0.1, Number.NaN, '0.5'])('a random source answering %o throws when asked', (r) => {
    const backoff = exponentialBackoff({ baseDelayMs: 10, jitter: 'equal', random: () => r as number });
    expect(() => backoff(1)).toThrow(/random\(\) must answer a number in \[0, 1\]/);
  });

  it('a ceiling saturates at Number.MAX_SAFE_INTEGER — never Infinity, never NaN', () => {
    expect(exponentialBackoff({ baseDelayMs: 1, multiplier: 10 })(1_000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(exponentialBackoff({ baseDelayMs: 1, multiplier: 10, jitter: 'full', random: fixed(0) })(1_000)).toBe(0);
  });

  it('an attempt is read as its whole part, at least 1', () => {
    const backoff = exponentialBackoff({ baseDelayMs: 100 });
    expect([0, -3, Number.NaN, Number.POSITIVE_INFINITY, 2.7].map((n) => backoff(n))).toEqual([
      100, 100, 100, 100, 200,
    ]);
  });
});

describe('statedWaitFirst — a stated wait wins, else the schedule', () => {
  const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number } | undefined)?.retryAfterMs;

  it('a stated wait wins over the schedule — 0 included', () => {
    const backoff = statedWaitFirst(retryAfterMs, exponentialBackoff({ baseDelayMs: 100 }));
    expect(backoff(1, { retryAfterMs: 2_500 })).toBe(2_500);
    expect(backoff(4, { retryAfterMs: 0 })).toBe(0);
  });

  it('no stated wait: the inner backoff decides, handed the attempt and the error', () => {
    const inner = vi.fn((n: number) => n * 10);
    const error = new Error('busy');
    expect(statedWaitFirst(retryAfterMs, inner)(3, error)).toBe(30);
    expect(inner).toHaveBeenCalledWith(3, error);
  });

  it('the inner backoff may be a fixed number of milliseconds', () => {
    expect(statedWaitFirst(retryAfterMs, 750)(2, new Error('busy'))).toBe(750);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '2500', null])(
    'a stated wait of %o is no stated wait: the schedule decides',
    (stated) => {
      expect(statedWaitFirst(() => stated as number, 40)(1, undefined)).toBe(40);
    },
  );

  it('a reader that throws states nothing — the schedule decides', () => {
    const hostile = () => {
      throw new Error('getter exploded');
    };
    expect(statedWaitFirst(hostile, 40)(1, undefined)).toBe(40);
  });

  it('refuses a reader that is not a function, and an inner that is not a backoff', () => {
    expect(() => statedWaitFirst(5 as never, 40)).toThrow(/statedWaitFirst: readStatedWaitMs must be a function/);
    expect(() => statedWaitFirst(retryAfterMs, -1)).toThrow(RangeError);
    expect(() => statedWaitFirst(retryAfterMs, Number.NaN)).toThrow(/inner must be a backoff function or a finite/);
    expect(() => statedWaitFirst(retryAfterMs, 'soon' as never)).toThrow(TypeError);
  });
});

describe('on the runner — the record explains every wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fails `fails` times with an error stating `retryAfterMs` (when given), then answers. */
  const failing =
    (fails: number, retryAfterMs?: number) =>
    (n: number): Promise<string> =>
      n <= fails
        ? Promise.reject(Object.assign(new Error('busy'), retryAfterMs === undefined ? {} : { retryAfterMs }))
        : Promise.resolve('ok');

  it('each record and each retry event carries the wait drawn; maxBackoffMs caps it', async () => {
    const records: AttemptRecord[] = [];
    const retries: number[] = [];
    const started = Date.now();
    const done = runAttempts(
      failing(3),
      {
        attempts: 4,
        backoffMs: exponentialBackoff({ baseDelayMs: 100, jitter: 'full', random: sequence(0.5, 0.25, 1) }),
        maxBackoffMs: 300,
      },
      { series: 's#0', onAttempt: (r) => records.push(r), onRetry: (_n, _of, delayMs) => retries.push(delayMs) },
    );
    await vi.runAllTimersAsync();
    expect(await done).toBe('ok');
    // ceilings 100, 200, 400 drawn at 0.5, 0.25, 1 → 50, 50, 400 — the last capped at 300
    expect(records.map((r) => r.delayMs)).toEqual([50, 50, 300, undefined]);
    expect(retries).toEqual([50, 50, 300]);
    expect(Date.now() - started).toBe(400);
  });

  it('a stated wait that would outlast the deadline stops the series no-time-left, with the wait on the record', async () => {
    const records: AttemptRecord[] = [];
    const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
    const done = runAttempts(
      failing(1, 5_000),
      { attempts: 3, backoffMs: statedWaitFirst(retryAfterMs, exponentialBackoff({ baseDelayMs: 10 })) },
      { series: 's#0', deadline: Date.now() + 1_000, onAttempt: (r) => records.push(r) },
    );
    const settled = expect(done).rejects.toThrow('busy');
    await vi.runAllTimersAsync();
    await settled;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ next: 'stop', reason: 'no-time-left', delayMs: 5_000 });
  });
});
