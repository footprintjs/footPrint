/**
 * `attempt/runner.ts · runAttempts` under a time budget (design §3.1, P1b): the attempt's own cap
 * (`RetryPolicy.timeoutMs`), the run's deadline, the attempt signal handed to the function, and
 * `backoffMs(n, error)`.
 *
 * The loop is P1a's; what P1b adds is TIME: every attempt runs under `min(timeoutMs, time left)`, its signal aborts
 * at that cap (an `AttemptTimeoutError`, outcome `'timeout'`), rule 6 stops a series whose next wait would outlast
 * the deadline (`no-time-left`), and the run's deadline is not a cancellation — an attempt it cut short timed out.
 *
 * Test types: Unit (the cap, the context, the inputs, the record's time fields) · Boundary (`attempts: 1` with a
 * cap; a deadline already spent before a retry; a wait cut by the deadline) · Security (the attempt signal is
 * aborted synchronously — `onAbandon` fires before any later microtask of the abandoned function).
 */
import { describe, expect, it, vi } from 'vitest';

import { deadlineReason, isDeadlineReason } from '../../../../src/lib/attempt/deadline.js';
import { AttemptTimeoutError } from '../../../../src/lib/attempt/errors.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptContext, AttemptRecord, AttemptSummary } from '../../../../src/lib/attempt/types.js';

const never = () => new Promise<never>(() => undefined);

function collect() {
  const records: AttemptRecord[] = [];
  const summaries: AttemptSummary[] = [];
  return {
    records,
    summaries,
    onAttempt: (record: AttemptRecord) => records.push(record),
    onEnd: (summary: AttemptSummary) => summaries.push(summary),
  };
}

describe('the attempt cap — RetryPolicy.timeoutMs', () => {
  it('an attempt that outlives its cap times out: outcome and category timeout, the error is AttemptTimeoutError', async () => {
    const c = collect();
    const error = await runAttempts(never, { attempts: 1, timeoutMs: 20 }, { series: 's#0', ...c }).catch((e) => e);
    expect(error).toBeInstanceOf(AttemptTimeoutError);
    expect(error).toMatchObject({ attempt: 1, timeoutMs: 20 });
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({
      attempt: 1,
      of: 1,
      outcome: 'timeout',
      category: 'timeout',
      next: 'stop',
      reason: 'exhausted',
      timeoutMs: 20,
      error: { name: 'AttemptTimeoutError' },
    });
    expect(c.records[0].timeLeftMs).toBeUndefined(); // no deadline, no time left to report
    expect(c.summaries[0]).toMatchObject({ count: 1, timeout: 1, last: { next: 'stop', reason: 'exhausted' } });
  });

  it('the function receives the attempt context; its signal aborts at the cap with the timeout as its reason', async () => {
    const seen: AttemptContext[] = [];
    const reasons: unknown[] = [];
    const run = (_n: number, t: AttemptContext) => {
      seen.push(t);
      return new Promise<never>((_resolve, reject) => {
        t.signal.addEventListener('abort', () => {
          reasons.push(t.signal.reason);
          reject(t.signal.reason);
        });
      });
    };
    await expect(runAttempts(run, { attempts: 2, timeoutMs: 15 }, { series: 'fetch#4' })).rejects.toBeInstanceOf(
      AttemptTimeoutError,
    );
    expect(seen.map((t) => [t.series, t.attempt, t.of, t.timeoutMs])).toEqual([
      ['fetch#4', 1, 2, 15],
      ['fetch#4', 2, 2, 15],
    ]);
    expect(seen[0].timeLeftMs()).toBe(Infinity);
    expect(reasons.every((r) => r instanceof AttemptTimeoutError)).toBe(true);
  });

  it('a timed-out attempt is retried like any failure, and retryOn sees the AttemptTimeoutError', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const run = () => (++calls === 1 ? never() : Promise.resolve('ok'));
    const c = collect();
    await expect(
      runAttempts(
        run,
        {
          attempts: 3,
          timeoutMs: 10,
          retryOn: (e) => {
            seen.push(e);
            return true;
          },
        },
        { series: 's#0', ...c },
      ),
    ).resolves.toBe('ok');
    expect(seen[0]).toBeInstanceOf(AttemptTimeoutError);
    expect(c.records.map((r) => [r.outcome, r.next])).toEqual([
      ['timeout', 'retry'],
      ['ok', 'done'],
    ]);
  });

  it('a timer is never left behind: an attempt that answers first clears its own cap', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await runAttempts(async () => 'fast', { attempts: 1, timeoutMs: 60_000 }, { series: 's#0' });
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('onAbandon fires SYNCHRONOUSLY when the attempt signal aborts — before the abandoned function runs on', async () => {
    const order: string[] = [];
    const run = (_n: number, t: AttemptContext) =>
      new Promise<never>(() => {
        t.signal.addEventListener('abort', () => order.push('function saw abort'));
      });
    await runAttempts(
      run,
      { attempts: 1, timeoutMs: 5 },
      { series: 's#0', onAbandon: (n) => order.push(`abandon ${n}`) },
    ).catch(() => undefined);
    expect(order[0]).toBe('abandon 1');
  });

  it('a failed attempt is abandoned too (its late work must not land); a successful or paused one is not', async () => {
    const abandoned: number[] = [];
    let calls = 0;
    await runAttempts(
      async () => {
        if (++calls === 1) throw new Error('boom');
        return 'ok';
      },
      { attempts: 2 },
      { series: 's#0', onAbandon: (n) => abandoned.push(n) },
    );
    expect(abandoned).toEqual([1]);
  });
});

describe('the run deadline', () => {
  it('rule 6: a wait that would outlast the deadline stops the series — no-time-left, with the time left and the wait', async () => {
    let t = 1_000;
    const c = collect();
    const backoff = vi.fn(() => 500);
    const error = await runAttempts(
      async () => {
        t += 100;
        throw new Error('busy');
      },
      { attempts: 5, backoffMs: backoff },
      { series: 's#0', deadline: 1_400, now: () => t, ...c },
    ).catch((e) => e);
    expect(error.message).toBe('busy');
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({
      outcome: 'failed',
      next: 'stop',
      reason: 'no-time-left',
      timeLeftMs: 300,
      delayMs: 500,
    });
    expect(backoff).toHaveBeenCalledTimes(1);
  });

  it('a retry under a deadline carries the time left at its decision', async () => {
    let t = 0;
    let calls = 0;
    const c = collect();
    await runAttempts(
      async () => {
        t += 10;
        if (++calls === 1) throw new Error('once');
        return 'ok';
      },
      { attempts: 2, backoffMs: 1 },
      { series: 's#0', deadline: 10_000, now: () => t, ...c },
    );
    expect(c.records.map((r) => [r.next, r.timeLeftMs, r.delayMs])).toEqual([
      ['retry', 9_990, 1],
      ['done', 9_980, undefined],
    ]);
  });

  it('an attempt is capped by the time left: its context says so, and timeoutMs is the smaller of the two', async () => {
    const seen: AttemptContext[] = [];
    let t = 0;
    await runAttempts(
      (_n, ctx) => {
        seen.push(ctx);
        return 'ok';
      },
      { attempts: 1, timeoutMs: 5_000 },
      { series: 's#0', deadline: 2_000, now: () => t },
    );
    expect(seen[0]).toMatchObject({ deadline: 2_000, timeoutMs: 2_000 });
    t = 500;
    expect(seen[0].timeLeftMs()).toBe(1_500);
  });

  it('the run signal aborting for the DEADLINE is not a cancellation: the attempt timed out, rule 3 does not match', async () => {
    const run = new AbortController();
    const reason = deadlineReason('Execution timed out after 30ms');
    const c = collect();
    // The simulated deadline abort lands AFTER the deadline: a 10ms timer may fire ~1ms before Date.now() reaches a
    // deadline set 10ms out, which leaves time on the clock at the decision and turns the stop into a retry (seen on CI).
    const deadline = Date.now() + 10;
    setTimeout(() => run.abort(reason), 15);
    const error = await runAttempts(
      never,
      { attempts: 3 },
      {
        series: 's#0',
        signal: run.signal,
        deadline,
        ...c,
      },
    ).catch((e) => e);
    expect(error).toBe(reason);
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({
      outcome: 'timeout',
      category: 'timeout',
      next: 'stop',
      reason: 'no-time-left',
    });
    const aborted = c.records[0].decision.rules.find((r) => r.label === 'aborted');
    expect(aborted?.matched).toBe(false);
  });

  it('a cancellation is still a cancellation: the run signal aborted for another reason stops the series aborted', async () => {
    const run = new AbortController();
    const c = collect();
    setTimeout(() => run.abort(new Error('user cancelled')), 5);
    await runAttempts(
      never,
      { attempts: 3 },
      { series: 's#0', signal: run.signal, deadline: Date.now() + 60_000, ...c },
    ).catch(() => undefined);
    expect(c.records[0]).toMatchObject({ outcome: 'aborted', next: 'stop', reason: 'aborted' });
  });

  it('deadlineReason is branded; an ordinary error is not', () => {
    expect(isDeadlineReason(deadlineReason('x'))).toBe(true);
    expect(isDeadlineReason(new Error('x'))).toBe(false);
    expect(isDeadlineReason('x')).toBe(false);
    expect(deadlineReason('Execution timed out after 5ms').message).toBe('Execution timed out after 5ms');
  });
});

describe('backoffMs(n, error)', () => {
  it('the function form receives the attempt that failed AND its error — a stated wait plugs in here', async () => {
    const calls: Array<[number, unknown]> = [];
    const errors = [Object.assign(new Error('slow down'), { retryAfterMs: 3 }), new Error('again')];
    let i = 0;
    await runAttempts(
      async () => {
        if (i < errors.length) throw errors[i++];
        return 'ok';
      },
      {
        attempts: 3,
        backoffMs: (n, error) => {
          calls.push([n, error]);
          return (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
        },
      },
      { series: 's#0' },
    );
    expect(calls).toEqual([
      [1, errors[0]],
      [2, errors[1]],
    ]);
  });
});

describe('a wait cut by the deadline', () => {
  it('ends the series with no-time-left, not aborted', async () => {
    const run = new AbortController();
    const c = collect();
    let t = 0;
    const p = runAttempts(
      async () => {
        throw new Error('fail');
      },
      { attempts: 3, backoffMs: 50 },
      // The clock says 10s are left, so the series decides to wait; the run's deadline fires during the wait.
      { series: 's#0', signal: run.signal, deadline: 10_000, now: () => t, ...c },
    );
    setTimeout(() => {
      t = 10_000;
      run.abort(deadlineReason('deadline'));
    }, 5);
    await expect(p).rejects.toThrow('fail');
    expect(c.records).toHaveLength(1);
    expect(c.records[0].next).toBe('retry');
    expect(c.summaries.at(-1)?.last).toMatchObject({ next: 'stop', reason: 'no-time-left' });
  });
});
