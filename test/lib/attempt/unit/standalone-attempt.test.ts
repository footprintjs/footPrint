/**
 * `attempt()` — the attempt runner with no scope and no run (design §3.6, packet P2). The same loop, the same
 * record; the records go to the caller's `onAttempt` only.
 *
 * Test types: Unit / Functional (a single attempt is recorded; retries; the policy's cap; a deadline; a signal; an
 * observed report through `t.observed`) · Boundary (no policy; a deadline already past; a throwing `onAttempt`; a
 * malformed policy, target or option).
 */
import { describe, expect, it } from 'vitest';

import type { AttemptContext, AttemptRecord } from '../../../../src/index.js';
import { attempt, AttemptTimeoutError } from '../../../../src/index.js';

const hang = (t: AttemptContext) =>
  new Promise<never>((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason)));

describe('attempt() — one runner, no scope', () => {
  it('a single attempt with no policy is still recorded', async () => {
    const records: AttemptRecord[] = [];
    const value = await attempt(() => 'answer', undefined, {
      target: 'inventory.lookup',
      onAttempt: (r) => records.push(r),
    });
    expect(value).toBe('answer');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      series: 'inventory.lookup',
      kind: 'call',
      target: 'inventory.lookup',
      attempt: 1,
      of: 1,
      outcome: 'ok',
      next: 'done',
      reason: 'succeeded',
    });
  });

  it('retries under the policy, and rejects with the LAST attempt’s own error', async () => {
    const records: AttemptRecord[] = [];
    let calls = 0;
    const last = new Error('third');
    await expect(
      attempt(
        () => {
          calls += 1;
          throw calls === 3 ? last : new Error(`try ${calls}`);
        },
        { attempts: 3 },
        { target: 'flaky', onAttempt: (r) => records.push(r) },
      ),
    ).rejects.toBe(last);
    expect(records.map((r) => [r.attempt, r.next, r.reason])).toEqual([
      [1, 'retry', 'retryable'],
      [2, 'retry', 'retryable'],
      [3, 'stop', 'exhausted'],
    ]);
  });

  it('`series` names the operation; without one the target does, and without a target "attempt"', async () => {
    const seen: string[] = [];
    const onAttempt = (r: AttemptRecord) => seen.push(r.series);
    await attempt(() => 1, undefined, { series: 'order-77', target: 'charge', onAttempt });
    await attempt(() => 1, undefined, { target: 'charge', onAttempt });
    await attempt(() => 1, undefined, { onAttempt });
    expect(seen).toEqual(['order-77', 'charge', 'attempt']);
  });

  it('the policy’s cap times an attempt out — the runner races it, the caller never waits past the cap', async () => {
    const records: AttemptRecord[] = [];
    const started = Date.now();
    await expect(
      attempt(
        () => new Promise(() => undefined),
        { attempts: 2, timeoutMs: 15 },
        { onAttempt: (r) => records.push(r) },
      ),
    ).rejects.toBeInstanceOf(AttemptTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(records.map((r) => [r.outcome, r.category, r.timeoutMs])).toEqual([
      ['timeout', 'timeout', 15],
      ['timeout', 'timeout', 15],
    ]);
  });

  it('a deadline caps every attempt even beside a caller’s signal, and is a timeout, not a cancellation', async () => {
    const records: AttemptRecord[] = [];
    const caller = new AbortController(); // never aborts
    await expect(
      attempt(
        hang,
        { attempts: 3 },
        { deadline: Date.now() + 25, signal: caller.signal, onAttempt: (r) => records.push(r) },
      ),
    ).rejects.toThrow(/deadline/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'timeout', category: 'timeout', next: 'stop' });
    expect(['no-time-left', 'exhausted']).toContain(records[0].reason);
  });

  it('the caller’s signal cancels: the attempt is aborted and nothing follows', async () => {
    const records: AttemptRecord[] = [];
    const caller = new AbortController();
    const pending = attempt(hang, { attempts: 5 }, { signal: caller.signal, onAttempt: (r) => records.push(r) });
    caller.abort(new Error('stop now'));
    await expect(pending).rejects.toThrow('stop now');
    expect(records.map((r) => [r.outcome, r.reason])).toEqual([['aborted', 'aborted']]);
  });

  it('a deadline already past: no attempt starts, nothing is recorded', async () => {
    const records: AttemptRecord[] = [];
    let called = false;
    await expect(
      attempt(
        () => {
          called = true;
        },
        undefined,
        { deadline: Date.now() - 1, onAttempt: (r) => records.push(r) },
      ),
    ).rejects.toThrow(/deadline/);
    expect(called).toBe(false);
    expect(records).toEqual([]);
  });

  it('a deadline of -Infinity is long past: no attempt starts', async () => {
    let called = false;
    await expect(
      attempt(
        () => {
          called = true;
        },
        undefined,
        { deadline: -Infinity },
      ),
    ).rejects.toThrow(/deadline/);
    expect(called).toBe(false);
  });

  it('`t.observed()` reports an SDK’s own attempt, under the attempt it was made in', async () => {
    const records: AttemptRecord[] = [];
    await attempt(
      (t) => {
        t.observed({ target: 'stripe', attempt: 1, of: 2, outcome: 'failed', durationMs: 30, error: { status: 503 } });
        t.observed({ target: 'stripe', attempt: 2, of: 2, outcome: 'ok', durationMs: 20 });
        return 'done';
      },
      undefined,
      { series: 'order-1', target: 'charge', onAttempt: (r) => records.push(r) },
    );
    expect(records.map((r) => [r.kind, r.series, r.attempt, r.outcome])).toEqual([
      ['observed', 'order-1@1.1', 1, 'failed'],
      ['observed', 'order-1@1.1', 2, 'ok'],
      ['call', 'order-1', 1, 'ok'],
    ]);
    expect(records[0]).toMatchObject({ target: 'stripe', source: 'sdk', category: 'server' });
  });

  it('an observed report after its attempt ended is dropped — never thrown into the SDK’s callback', async () => {
    const records: AttemptRecord[] = [];
    let held!: AttemptContext;
    await attempt(
      (t) => {
        held = t;
      },
      undefined,
      { onAttempt: (r) => records.push(r) },
    );
    expect(() => held.observed({ target: 'stripe', outcome: 'ok', durationMs: 1 })).not.toThrow();
    expect(records.map((r) => r.kind)).toEqual(['call']);
    // A malformed report is still the adapter's bug.
    expect(() => held.observed({ target: '', outcome: 'ok', durationMs: 1 })).toThrow(TypeError);
  });

  it('a throwing onAttempt never changes the call’s outcome', async () => {
    await expect(
      attempt(() => 7, undefined, {
        onAttempt: () => {
          throw new Error('logger broke');
        },
      }),
    ).resolves.toBe(7);
  });
});

describe('attempt() — refusals (the caller’s contract: a TypeError naming the field)', () => {
  it.each([
    ['fn not a function', () => attempt(42 as never)],
    ['attempts 0', () => attempt(() => 1, { attempts: 0 })],
    ['attempts NaN', () => attempt(() => 1, { attempts: Number.NaN })],
    ['timeoutMs 0', () => attempt(() => 1, { attempts: 1, timeoutMs: 0 })],
    ['a policy that is not an object', () => attempt(() => 1, 3 as never)],
    ['a bad target', () => attempt(() => 1, undefined, { target: 'a\nb' })],
    ['a bad series', () => attempt(() => 1, undefined, { series: '' })],
    ['a signal that is not one', () => attempt(() => 1, undefined, { signal: {} as AbortSignal })],
    ['onAttempt not a function', () => attempt(() => 1, undefined, { onAttempt: 'log' as never })],
  ])('%s', (_why, call) => {
    expect(call).toThrow(TypeError);
  });
});
