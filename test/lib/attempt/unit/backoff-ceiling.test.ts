/**
 * `RetryPolicy.maxBackoffMs` — the declared ceiling on ONE wait, ENFORCED by the runner (design §3.2, P5 review).
 *
 * WHY: the static budget check cannot ask a function backoff (it may read the error, and no error exists at build),
 * so a function backoff is countable only by a declared ceiling. The declaration must not be able to lie: the runner
 * waits `min(backoffMs's answer, maxBackoffMs)` whatever the error stated.
 *
 * Test types: Unit (the cap on a function and on a number; the record's `delayMs` and `onStageRetry`'s delay are the
 * capped wait; `0` means retry at once; no ceiling, no cap) · Boundary (the policy reader: `backoffCeilingMs` /
 * `retryPolicyProblem`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backoffCeilingMs, cappedWaitMs, retryPolicyProblem } from '../../../../src/lib/attempt/policy.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord } from '../../../../src/lib/attempt/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Fails with an error that states its own wait, `n` times, then answers. */
const statingFailures = (fails: number, statedMs: number) => (n: number) =>
  n <= fails ? Promise.reject(Object.assign(new Error('busy'), { retryAfterMs: statedMs })) : Promise.resolve('ok');
const stated = (_n: number, error: unknown) => (error as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 1;

async function run(policy: Parameters<typeof runAttempts>[1], fails: number, statedMs: number) {
  const records: AttemptRecord[] = [];
  const started = Date.now();
  const done = runAttempts(statingFailures(fails, statedMs), policy, {
    series: 's#0',
    onAttempt: (r) => records.push(r),
  });
  await vi.runAllTimersAsync();
  const value = await done;
  return { value, records, elapsed: Date.now() - started };
}

describe('the runner caps every wait at maxBackoffMs', () => {
  it('a stated wait of 60 s under a 25 ms ceiling waits 25 ms — the record says so', async () => {
    const { value, records, elapsed } = await run({ attempts: 3, backoffMs: stated, maxBackoffMs: 25 }, 2, 60_000);
    expect(value).toBe('ok');
    expect(records.map((r) => r.delayMs)).toEqual([25, 25, undefined]);
    expect(elapsed).toBe(50);
  });

  it('a number backoff is capped too; a stated wait under the ceiling is waited as stated', async () => {
    expect((await run({ attempts: 2, backoffMs: 1_000, maxBackoffMs: 30 }, 1, 0)).elapsed).toBe(30);
    expect((await run({ attempts: 2, backoffMs: stated, maxBackoffMs: 500 }, 1, 40)).elapsed).toBe(40);
  });

  it('a ceiling of 0 retries at once; no ceiling waits what the backoff says', async () => {
    expect((await run({ attempts: 2, backoffMs: stated, maxBackoffMs: 0 }, 1, 9_000)).elapsed).toBe(0);
    expect((await run({ attempts: 2, backoffMs: stated }, 1, 9_000)).elapsed).toBe(9_000);
  });

  it('onStageRetry hears the capped wait', async () => {
    const delays: number[] = [];
    const done = runAttempts(
      statingFailures(1, 5_000),
      { attempts: 2, backoffMs: stated, maxBackoffMs: 7 },
      {
        series: 's#0',
        onRetry: (_n, _of, delayMs) => delays.push(delayMs),
      },
    );
    await vi.runAllTimersAsync();
    await done;
    expect(delays).toEqual([7]);
  });
});

describe('the one reading of the ceiling', () => {
  it('backoffCeilingMs: a finite number >= 0, else none; cappedWaitMs applies it', () => {
    expect(backoffCeilingMs(0)).toBe(0);
    expect(backoffCeilingMs(12.5)).toBe(12.5);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', undefined])
      expect(backoffCeilingMs(bad)).toBeUndefined();
    expect(cappedWaitMs(100, 30)).toBe(30);
    expect(cappedWaitMs(10, 30)).toBe(10);
    expect(cappedWaitMs(100, undefined)).toBe(100);
  });

  it('retryPolicyProblem refuses a declared ceiling that is not a finite number >= 0', () => {
    expect(retryPolicyProblem({ attempts: 2, maxBackoffMs: -1 })).toMatch(/retry.maxBackoffMs must be/);
    expect(retryPolicyProblem({ attempts: 2, maxBackoffMs: Number.POSITIVE_INFINITY })).toMatch(/maxBackoffMs/);
    expect(retryPolicyProblem({ attempts: 2, maxBackoffMs: 0 })).toBeUndefined();
  });
});
