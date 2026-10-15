/**
 * `attempt/runner.ts · runAttempts` — the ONE retry loop (design §3.1, law 1), unit-tested without the engine.
 *
 * The engine's stage retry moved onto this runner with its behaviour unchanged: the same calls of the stage
 * function, of `retryOn` and of `backoffMs`, the same error rethrown, and a failed attempt's 9.15 order —
 * `retryOn` → the abort check → the discard (`between`) → `backoffMs` → the served error → the retry event → the
 * wait → the abort check. What it adds is the record — one frozen `AttemptRecord` per try, and one
 * `AttemptSummary` when the series ends — and the record never rewrites what the attempt did.
 *
 * Test types: Unit (each outcome and stop reason; callback order; the record's fields; the clock) · Boundary
 * (backoff and predicate failures; an abort before, inside `retryOn`, inside `backoffMs` and during the wait — the
 * three edge cases the 9.15 order decides; a `retryOn` that edits the thrown value; broken and non-integer
 * ceilings) · Security (the record holds the SERVED error without `raw`; it is frozen and survives
 * structuredClone).
 */
import { describe, expect, it, vi } from 'vitest';

import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord, AttemptSummary, RetryPolicy } from '../../../../src/lib/attempt/types.js';
import { PauseSignal } from '../../../../src/lib/pause/types.js';

/** A clock that advances `step` ms per reading, from `start`. */
function clock(start = 1_000, step = 5) {
  let t = start - step;
  return () => (t += step);
}

/** Every callback the runner calls, in order, as short labels. */
function harness(policy: RetryPolicy, extra: { signal?: AbortSignal; serve?: (e: unknown) => any } = {}) {
  const log: string[] = [];
  const records: AttemptRecord[] = [];
  const served: unknown[] = [];
  const summaries: AttemptSummary[] = [];
  const thrownByPredicate: unknown[] = [];
  const options = {
    series: 'flaky#3',
    signal: extra.signal,
    now: clock(),
    serve: extra.serve,
    between: (n: number) => log.push(`between ${n}`),
    onAttempt: (record: AttemptRecord, structuredError: unknown) => {
      log.push(`attempt ${record.attempt} ${record.outcome} ${record.next}`);
      records.push(record);
      served.push(structuredError);
    },
    onRetry: (n: number, of: number, delayMs: number) => log.push(`retry ${n}/${of} wait ${delayMs}`),
    onEnd: (summary: AttemptSummary) => {
      log.push('end');
      summaries.push(summary);
    },
    onRetryOnThrew: (thrown: unknown) => thrownByPredicate.push(thrown),
  };
  return { policy, options, log, records, served, summaries, thrownByPredicate };
}

/** A function that throws `Error('boom <n>')` for its first `fails` calls, then returns `'ok <n>'`. */
function flaky(fails: number) {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls += 1;
    if (calls <= fails) throw new Error(`boom ${calls}`);
    return `ok ${calls}`;
  });
  return fn;
}

describe('runAttempts — outcomes and stop reasons', () => {
  it('a first-try success is ONE record: done, succeeded — no discard, no retry event', async () => {
    const h = harness({ attempts: 3 });
    await expect(runAttempts(flaky(0), h.policy, h.options)).resolves.toBe('ok 1');
    expect(h.log).toEqual(['end', 'attempt 1 ok done']);
    expect(h.records[0]).toEqual({
      series: 'flaky#3',
      kind: 'stage',
      attempt: 1,
      of: 3,
      startedAt: 1_000,
      durationMs: 5,
      outcome: 'ok',
      decision: expect.objectContaining({ chosen: 'done' }),
      next: 'done',
      reason: 'succeeded',
    });
    expect(h.summaries).toEqual([
      { count: 1, ok: 1, failed: 0, timeout: 0, aborted: 0, paused: 0, last: { next: 'done', reason: 'succeeded' } },
    ]);
  });

  it('recovers: each failed try discards, then asks the wait, then records, announces the retry and waits — the 9.15 order', async () => {
    const backoffMs = vi.fn(() => 0);
    const h = harness({ attempts: 3, backoffMs });
    backoffMs.mockImplementation(() => {
      h.log.push('backoff');
      return 0;
    });
    await expect(runAttempts(flaky(2), h.policy, h.options)).resolves.toBe('ok 3');
    expect(h.log).toEqual([
      'between 1',
      'backoff',
      'attempt 1 failed retry',
      'retry 1/3 wait 0',
      'between 2',
      'backoff',
      'attempt 2 failed retry',
      'retry 2/3 wait 0',
      'end',
      'attempt 3 ok done',
    ]);
    expect(h.records.map((r) => [r.attempt, r.category, r.reason, r.delayMs])).toEqual([
      [1, 'unknown', 'retryable', 0],
      [2, 'unknown', 'retryable', 0],
      [3, undefined, 'succeeded', undefined],
    ]);
    expect(h.records[0].error).toEqual({ message: 'boom 1', name: 'Error' });
    expect(h.summaries[0]).toEqual({
      count: 3,
      ok: 1,
      failed: 2,
      timeout: 0,
      aborted: 0,
      paused: 0,
      last: { next: 'done', reason: 'succeeded' },
    });
  });

  it('exhausted: rethrows the LAST attempt’s own error; the last record stops', async () => {
    const h = harness({ attempts: 3 });
    const fn = flaky(99);
    const error = await runAttempts(fn, h.policy, h.options).catch((e: unknown) => e);
    expect((error as Error).message).toBe('boom 3');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(h.records.map((r) => [r.next, r.reason])).toEqual([
      ['retry', 'retryable'],
      ['retry', 'retryable'],
      ['stop', 'exhausted'],
    ]);
    expect(h.summaries[0].last).toEqual({ next: 'stop', reason: 'exhausted', category: 'unknown' });
  });

  it('declined: retryOn → false leaves ONE record (the stop that emitted nothing before 10.1)', async () => {
    const retryOn = vi.fn(() => false);
    const h = harness({ attempts: 4, retryOn });
    await expect(runAttempts(flaky(99), h.policy, h.options)).rejects.toThrow('boom 1');
    expect(h.log).toEqual(['end', 'attempt 1 failed stop']);
    expect(h.records[0].reason).toBe('declined');
    expect(retryOn).toHaveBeenCalledTimes(1);
    expect(retryOn.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('a pause is control flow: rethrown untouched, recorded paused, never retried, never served', async () => {
    const h = harness({ attempts: 3 });
    const pause = new PauseSignal({ q: 1 }, 'gate');
    const fn = vi.fn(async () => {
      throw pause;
    });
    await expect(runAttempts(fn, h.policy, h.options)).rejects.toBe(pause);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.records[0]).toMatchObject({ outcome: 'paused', next: 'stop', reason: 'paused' });
    expect(h.records[0].error).toBeUndefined();
    expect(h.records[0].category).toBeUndefined();
    expect(h.served).toEqual([undefined]);
    expect(h.summaries[0]).toMatchObject({ paused: 1, last: { next: 'stop', reason: 'paused' } });
  });

  it('the run’s signal aborted when the try ends: the attempt keeps its own failure; the abort is the stop reason', async () => {
    const controller = new AbortController();
    const retryOn = vi.fn(() => true);
    const backoffMs = vi.fn(() => 0);
    const h = harness({ attempts: 5, retryOn, backoffMs }, { signal: controller.signal });
    const fn = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('cut'), { status: 503 });
    });
    await expect(runAttempts(fn, h.policy, h.options)).rejects.toThrow('cut');
    expect(fn).toHaveBeenCalledTimes(1);
    // The abort decides first (rule 3 before rule 5): no user function is asked, nothing is discarded.
    expect(retryOn).not.toHaveBeenCalled();
    expect(backoffMs).not.toHaveBeenCalled();
    expect(h.log).toEqual(['end', 'attempt 1 failed stop']);
    // Never rewritten: it failed, with a 503 — the category says so — and the series stopped because of the abort.
    expect(h.records[0]).toMatchObject({ outcome: 'failed', category: 'server', next: 'stop', reason: 'aborted' });
    expect(h.records[0].error).toEqual({ message: 'cut', name: 'Error' });
    expect(h.summaries[0]).toMatchObject({
      failed: 1,
      aborted: 0,
      last: { next: 'stop', reason: 'aborted', category: 'server' },
    });
  });

  it('an attempt that threw the run’s own abort reason is aborted: the signal ended it', async () => {
    const controller = new AbortController();
    const h = harness({ attempts: 5 }, { signal: controller.signal });
    const fn = vi.fn(async () => {
      controller.abort();
      // What StageRunner's race rejects with — and what a stage that rethrows the signal's reason throws.
      throw controller.signal.reason;
    });
    const thrown = await runAttempts(fn, h.policy, h.options).catch((e: unknown) => e);
    expect(thrown).toBe(controller.signal.reason);
    expect(h.records[0]).toMatchObject({ outcome: 'aborted', category: 'unknown', next: 'stop', reason: 'aborted' });
    expect(h.summaries[0]).toMatchObject({ failed: 0, aborted: 1 });
  });
});

describe('runAttempts — the inputs run exactly when they ran before', () => {
  it('retryOn is asked only for a non-final, non-pause, non-aborted failure', async () => {
    const retryOn = vi.fn(() => true);
    const h = harness({ attempts: 3, retryOn });
    await runAttempts(flaky(99), h.policy, h.options).catch(() => undefined);
    // attempts 1 and 2 — never the final one.
    expect(retryOn).toHaveBeenCalledTimes(2);
  });

  it('backoffMs is called with the attempt that just failed, only when a retry follows', async () => {
    const backoffMs = vi.fn((n: number) => n);
    const h = harness({ attempts: 3, backoffMs });
    await runAttempts(flaky(99), h.policy, h.options).catch(() => undefined);
    expect(backoffMs.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(h.records.map((r) => r.delayMs)).toEqual([1, 2, undefined]);
  });

  it.each([
    ['a negative number', -50],
    ['NaN', NaN],
    ['Infinity', Infinity],
    [
      'a throwing function',
      () => {
        throw new Error('bad dial');
      },
    ],
  ])('a backoff of %s is no wait — the retry still happens', async (_label, backoffMs) => {
    const h = harness({ attempts: 2, backoffMs: backoffMs as RetryPolicy['backoffMs'] });
    await expect(runAttempts(flaky(1), h.policy, h.options)).resolves.toBe('ok 2');
    expect(h.records[0].delayMs).toBe(0);
  });

  it('a throwing retryOn is "do not retry", recorded apart from a real false; the throw goes to the engine to log', async () => {
    const broken = new Error('predicate is broken');
    const h = harness({
      attempts: 10,
      retryOn: () => {
        throw broken;
      },
    });
    await expect(runAttempts(flaky(99), h.policy, h.options)).rejects.toThrow('boom 1');
    expect(h.records[0]).toMatchObject({ next: 'stop', reason: 'declined', retryOnThrew: true });
    expect(h.summaries[0].last).toEqual({ next: 'stop', reason: 'declined', category: 'unknown', retryOnThrew: true });
    expect(h.thrownByPredicate).toEqual([broken]);
    // The evidence still shows the verdict the decision used: a throw is false.
    expect(h.records[0].decision.rules[4]).toMatchObject({
      label: 'declined',
      matched: true,
      inputs: [{ key: 'retryOn', valueSummary: 'false', redacted: false }],
    });
  });

  it('a real false carries no retryOnThrew flag', async () => {
    const h = harness({ attempts: 10, retryOn: () => false });
    await expect(runAttempts(flaky(99), h.policy, h.options)).rejects.toThrow('boom 1');
    expect(h.records[0].reason).toBe('declined');
    expect(Object.hasOwn(h.records[0], 'retryOnThrew')).toBe(false);
    expect(Object.hasOwn(h.summaries[0].last, 'retryOnThrew')).toBe(false);
  });

  it('waits the delay between attempts', async () => {
    const h = harness({ attempts: 2, backoffMs: 30 });
    const started = Date.now();
    await runAttempts(flaky(1), h.policy, h.options);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe('runAttempts — an abort around the decision', () => {
  it('an abort DURING the wait ends the series with no phantom attempt; the summary says how it ended', async () => {
    const controller = new AbortController();
    const h = harness({ attempts: 5, backoffMs: 5_000 }, { signal: controller.signal });
    h.options.onRetry = () => {
      h.log.push('retry');
      setTimeout(() => controller.abort(), 5);
    };
    const fn = flaky(99);
    const started = Date.now();
    await expect(runAttempts(fn, h.policy, h.options)).rejects.toThrow('boom 1');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.records.map((r) => r.next)).toEqual(['retry']);
    expect(h.summaries).toEqual([
      {
        count: 1,
        ok: 0,
        failed: 1,
        timeout: 0,
        aborted: 0,
        paused: 0,
        last: { next: 'stop', reason: 'aborted', category: 'unknown' },
      },
    ]);
  });

  it('(b) an abort raised inside retryOn stops before the discard — and backoffMs is never asked', async () => {
    // 9.15: retryOn → the abort check → throw. The discard, backoffMs and the retry event all come after.
    const controller = new AbortController();
    const backoffMs = vi.fn(() => 50);
    const retryOn = vi.fn(() => {
      controller.abort();
      return true;
    });
    const h = harness({ attempts: 3, retryOn, backoffMs }, { signal: controller.signal });
    await expect(runAttempts(flaky(99), h.policy, h.options)).rejects.toThrow('boom 1');
    expect(retryOn).toHaveBeenCalledTimes(1);
    expect(backoffMs).not.toHaveBeenCalled();
    expect(h.log).toEqual(['end', 'attempt 1 failed stop']);
    // The attempt keeps its own outcome; the decision taken again after retryOn is what stopped the series.
    expect(h.records[0]).toMatchObject({ outcome: 'failed', category: 'unknown', next: 'stop', reason: 'aborted' });
    expect(h.records[0].decision.rules.map((r) => [r.label, r.matched])).toEqual([
      ['succeeded', false],
      ['paused', false],
      ['aborted', true],
    ]);
    expect(Object.hasOwn(h.records[0], 'delayMs')).toBe(false);
  });

  it('(a) an abort raised inside backoffMs comes after the discard: the retry event still fires, then the series ends at the wait', async () => {
    // 9.15: the discard → backoffMs → onStageRetry → sleep → the abort check → throw. The failed attempt's
    // writes are discarded either way, so they never land on the error path.
    const controller = new AbortController();
    const backoffMs = vi.fn(() => {
      controller.abort();
      return 5_000;
    });
    const h = harness({ attempts: 5, backoffMs }, { signal: controller.signal });
    const fn = flaky(99);
    const started = Date.now();
    await expect(runAttempts(fn, h.policy, h.options)).rejects.toThrow('boom 1');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(backoffMs).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual(['between 1', 'attempt 1 failed retry', 'retry 1/5 wait 5000', 'end']);
    expect(h.records.map((r) => [r.next, r.delayMs])).toEqual([['retry', 5_000]]);
    expect(h.summaries).toEqual([
      {
        count: 1,
        ok: 0,
        failed: 1,
        timeout: 0,
        aborted: 0,
        paused: 0,
        last: { next: 'stop', reason: 'aborted', category: 'unknown' },
      },
    ]);
  });

  it('(c) the served error and the category are read AFTER retryOn — an edit it makes to the thrown value shows', async () => {
    // 9.15 served the error after retryOn (and backoffMs) ran, so onStageRetry saw what the predicate did to it.
    const retryOn = (error: unknown) => {
      Object.assign(error as Error, { message: 'boom 1 (seen by retryOn)', status: 503 });
      return true;
    };
    const h = harness({ attempts: 2, retryOn });
    const servedToRetry: unknown[] = [];
    // The fourth argument is the served error the engine hands `onStageRetry`.
    h.options.onRetry = (...args: unknown[]) => servedToRetry.push(args[3]);
    await expect(runAttempts(flaky(1), h.policy, h.options)).resolves.toBe('ok 2');
    expect(h.records[0].error).toEqual({ message: 'boom 1 (seen by retryOn)', name: 'Error' });
    expect(h.records[0].category).toBe('server');
    expect(servedToRetry).toEqual([expect.objectContaining({ message: 'boom 1 (seen by retryOn)' })]);
  });
});

describe('runAttempts — the record', () => {
  it('serves the error ONCE per failed try: the record keeps it without raw, the hook gets it whole', async () => {
    const serve = vi.fn((e: unknown) => ({ message: `served ${(e as Error).message}`, name: 'Error', raw: e }));
    const h = harness({ attempts: 2 }, { serve });
    await runAttempts(flaky(1), h.policy, h.options);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(h.records[0].error).toEqual({ message: 'served boom 1', name: 'Error' });
    expect(Object.hasOwn(h.records[0].error as object, 'raw')).toBe(false);
    expect((h.served[0] as { raw: unknown }).raw).toBeInstanceOf(Error);
  });

  it('keeps a served error’s code and validation issues, copied', async () => {
    const issues = [{ path: ['amount'], message: 'too small' }];
    const serve = () => ({ message: 'invalid', name: 'InputValidationError', code: 'E_IN', issues, raw: undefined });
    const h = harness({ attempts: 2 }, { serve });
    await runAttempts(flaky(1), h.policy, h.options);
    expect(h.records[0].error).toEqual({ message: 'invalid', name: 'InputValidationError', code: 'E_IN', issues });
    expect(h.records[0].error?.issues).not.toBe(issues);
  });

  it('is frozen to the leaves and survives structuredClone', async () => {
    const h = harness({ attempts: 2 });
    await runAttempts(flaky(1), h.policy, h.options);
    for (const record of h.records) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.decision)).toBe(true);
      expect(Object.isFrozen(record.decision.rules)).toBe(true);
      expect(record.decision.rules.every((rule) => Object.isFrozen(rule))).toBe(true);
      expect(structuredClone(record)).toEqual(record);
    }
    expect(Object.isFrozen(h.summaries[0])).toBe(true);
    expect(Object.isFrozen(h.summaries[0].last)).toBe(true);
  });

  it('times each try on the injected clock; a clock that runs backwards reads 0, never negative', async () => {
    const h = harness({ attempts: 2 });
    let t = 100;
    h.options.now = () => (t -= 10);
    await runAttempts(flaky(1), h.policy, h.options);
    expect(h.records.map((r) => r.durationMs)).toEqual([0, 0]);
    expect(h.records[0].startedAt).toBe(90);
  });

  it('a fractional ceiling is the whole number of attempts (as the 9.15 loop read it)', async () => {
    const h = harness({ attempts: 2.9 });
    await runAttempts(flaky(99), h.policy, h.options).catch(() => undefined);
    expect(h.records.map((r) => r.of)).toEqual([2, 2]);
    expect(h.records[1].reason).toBe('exhausted');
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['0', 0],
  ])('a broken ceiling (%s) is ONE attempt — never a loop', async (_label, attempts) => {
    const h = harness({ attempts });
    const fn = flaky(99);
    await expect(runAttempts(fn, h.policy, h.options)).rejects.toThrow('boom 1');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.records.map((r) => [r.of, r.reason])).toEqual([[1, 'exhausted']]);
  });

  it('defaults: kind is stage, the clock is Date.now, the served form is extractErrorInfo’s', async () => {
    const records: AttemptRecord[] = [];
    const before = Date.now();
    await runAttempts(flaky(1), { attempts: 2 }, { series: 's#0', onAttempt: (r) => records.push(r) });
    expect(records[0].kind).toBe('stage');
    expect(records[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(records[0].error).toEqual({ message: 'boom 1', name: 'Error' });
  });

  it('a synchronous attempt function is awaited the same way', async () => {
    let calls = 0;
    const value = await runAttempts(
      () => {
        calls += 1;
        if (calls < 2) throw new Error('sync boom');
        return 7;
      },
      { attempts: 2 },
      { series: 's#0' },
    );
    expect(value).toBe(7);
  });
});
