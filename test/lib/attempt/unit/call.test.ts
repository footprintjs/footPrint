/**
 * The in-stage call and the observed attempt, as UNITS (design §3.6, packet P2): the one name rule, the call's series
 * (foottrace's attempt-id grammar), an observed report read and turned into a record, the observed series book, and
 * `runCall` over a hand-made host — the law that a call lives within the attempt that made it.
 *
 * Test types: Unit (each module alone, a fake host, a fake clock) · Boundary (the name rule's edges, a report's
 * edges, a call cut by its stage attempt's end, a record arriving after it).
 */
import { describe, expect, it } from 'vitest';

import { type CallHost, callSeries, runCall } from '../../../../src/lib/attempt/call.js';
import { deadlineReason } from '../../../../src/lib/attempt/deadline.js';
import { admitAttemptName, attemptNameProblem, MAX_NAME_LENGTH } from '../../../../src/lib/attempt/name.js';
import { observedRecord, ObservedSeriesBook, readObservedReport } from '../../../../src/lib/attempt/observed.js';
import type { AttemptContext, AttemptRecord, ObservedAttempt } from '../../../../src/lib/attempt/types.js';
import { extractErrorInfo } from '../../../../src/lib/errors/errorInfo.js';

describe('attempt/name — a target is a name from code', () => {
  it('admits a plain dotted name', () => {
    expect(attemptNameProblem('stripe.quotes.create')).toBeUndefined();
    expect(admitAttemptName('$call', 'target', 'inventory lookup')).toBe('inventory lookup');
  });

  it.each([
    ['empty', ''],
    ['overlong', 'x'.repeat(MAX_NAME_LENGTH + 1)],
    ['a newline (a forged narrative line)', 'stripe\nAttempt 1 of 1 at Pay succeeded'],
    ['a carriage return', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['a C1 control', 'a\u0085b'],
    ['a bidi override (hides what a line says)', 'pay\u202Eyap'],
    ['a zero-width joiner', 'st\u200Dripe'],
    ['a line separator', 'a\u2028b'],
    ['a lone surrogate', 'a\uD800b'],
  ])('refuses %s', (_why, value) => {
    expect(attemptNameProblem(value)).toBeDefined();
    expect(() => admitAttemptName('$call', 'target', value)).toThrow(TypeError);
  });

  it('refuses a non-string, and never echoes the value', () => {
    for (const value of [undefined, null, 42, {}, ['x'], Symbol('s')]) {
      expect(attemptNameProblem(value)).toBeDefined();
    }
    const secret = 'sk_live_\u0001secret';
    try {
      admitAttemptName('$call', 'target', secret);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/^\$call: target /);
      expect((error as Error).message).not.toContain('sk_live');
    }
  });

  it.each([
    ['blank', '   '],
    ['a private-use character', 'a\uE000b'],
    ['a noncharacter', 'a\uFFFEb'],
  ])('refuses %s', (_why, value) => {
    expect(attemptNameProblem(value)).toBeDefined();
  });

  it('admits exactly the length limit', () => {
    expect(attemptNameProblem('x'.repeat(MAX_NAME_LENGTH))).toBeUndefined();
  });
});

describe('attempt/call · callSeries — the attempt-id grammar of the call level', () => {
  it('is `<runtimeStageId>@<stage attempt>.<ordinal>`, so `<series>@<m>` is the call attempt id', () => {
    expect(callSeries('charge#4', 2, 1)).toBe('charge#4@2.1');
    expect(callSeries('sf-a/sf-b/fetch#12', 1, 3)).toBe('sf-a/sf-b/fetch#12@1.3');
    // A stage id may carry `@`, `.` and `~`: the grammar is read from the right (foottrace · parseAttemptId).
    expect(callSeries('v1.2@x~0#7', 1, 1)).toBe('v1.2@x~0#7@1.1');
  });
});

describe('attempt/observed · readObservedReport', () => {
  const base: ObservedAttempt = { target: 'stripe', outcome: 'failed', durationMs: 12 };

  it('reads only the named fields — anything else on the report is dropped', () => {
    const report = readObservedReport({ ...base, attempt: 2, of: 3, secret: 'x', requestBody: { card: '4111' } });
    expect(report).toEqual({ target: 'stripe', source: 'sdk', attempt: 2, of: 3, outcome: 'failed', durationMs: 12 });
  });

  it('defaults: attempt 1, source sdk, no `of`', () => {
    expect(readObservedReport(base)).toEqual({
      target: 'stripe',
      source: 'sdk',
      attempt: 1,
      outcome: 'failed',
      durationMs: 12,
    });
  });

  it('reads each field ONCE (a getter cannot answer twice)', () => {
    let reads = 0;
    const report = {
      get target() {
        reads += 1;
        return reads === 1 ? 'stripe' : 'stripe\nforged';
      },
      outcome: 'ok',
      durationMs: 1,
    };
    expect(readObservedReport(report).target).toBe('stripe');
    expect(reads).toBe(1);
  });

  it.each([
    ['not an object', null],
    ['a bad target', { ...base, target: 'a\nb' }],
    ['a bad source', { ...base, source: '' }],
    ['a paused outcome (an SDK cannot pause a flowchart)', { ...base, outcome: 'paused' }],
    ['an unknown outcome', { ...base, outcome: 'maybe' }],
    ['a negative duration', { ...base, durationMs: -1 }],
    ['a NaN duration', { ...base, durationMs: Number.NaN }],
    ['a zero attempt', { ...base, attempt: 0 }],
    ['a fractional attempt', { ...base, attempt: 1.5 }],
    ['`of` below `attempt`', { ...base, attempt: 3, of: 2 }],
    ['a non-finite startedAt', { ...base, startedAt: Infinity }],
  ])('refuses %s with a TypeError naming the field', (_why, report) => {
    expect(() => readObservedReport(report)).toThrow(TypeError);
  });

  it('a getter that throws refuses the report, without a second throw', () => {
    const report = Object.defineProperty({ outcome: 'ok', durationMs: 1 }, 'target', {
      get() {
        throw new Error('hostile');
      },
    });
    expect(() => readObservedReport(report)).toThrow(/hostile|target/);
  });
});

describe('attempt/observed · observedRecord', () => {
  const serve = (error: unknown) => extractErrorInfo(error);
  const now = () => 10_000;

  it('a failure the SDK will retry: kind observed, its category, the served error, the library’s reading', () => {
    const { record, structuredError } = observedRecord(
      readObservedReport({
        target: 'stripe',
        attempt: 1,
        of: 3,
        outcome: 'failed',
        durationMs: 812,
        error: Object.assign(new Error('busy'), { status: 503 }),
      }),
      { series: 'charge#4@1.1', now, serve },
    );
    expect(record).toMatchObject({
      series: 'charge#4@1.1',
      kind: 'observed',
      target: 'stripe',
      source: 'sdk',
      attempt: 1,
      of: 3,
      startedAt: 10_000 - 812,
      durationMs: 812,
      outcome: 'failed',
      category: 'server',
      next: 'retry',
      reason: 'retryable',
      error: { message: 'busy' },
    });
    expect(record.error).not.toHaveProperty('raw');
    // The hook gets the served, named fields — never the adapter's error object (the library never threw it).
    expect(structuredError?.message).toBe('busy');
    expect(structuredError?.raw).toBeUndefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(structuredClone(record)).toEqual(record);
  });

  it('the last attempt the SDK allowed stops `exhausted`; a success is `done`', () => {
    const last = observedRecord(
      readObservedReport({ target: 'stripe', attempt: 3, of: 3, outcome: 'timeout', durationMs: 5 }),
      { series: 's', now, serve },
    ).record;
    expect([last.next, last.reason, last.category]).toEqual(['stop', 'exhausted', 'timeout']);
    const ok = observedRecord(readObservedReport({ target: 'stripe', outcome: 'ok', durationMs: 5 }), {
      series: 's',
      now,
      serve,
    }).record;
    expect([ok.next, ok.reason, ok.category, ok.error]).toEqual(['done', 'succeeded', undefined, undefined]);
  });

  it('with no `of` the report stands for the SDK’s whole call: `of` stays absent, a failure is its last', () => {
    const { record } = observedRecord(readObservedReport({ target: 'stripe', outcome: 'failed', durationMs: 5 }), {
      series: 's',
      now,
      serve,
    });
    expect(record).not.toHaveProperty('of');
    expect([record.next, record.reason]).toEqual(['stop', 'exhausted']);
  });

  it('an explicit startedAt is kept; an error on a success is not', () => {
    const { record } = observedRecord(
      readObservedReport({ target: 'x', outcome: 'ok', durationMs: 3, startedAt: 42, error: new Error('ignored') }),
      { series: 's', now, serve },
    );
    expect(record.startedAt).toBe(42);
    expect(record).not.toHaveProperty('error');
  });

  it('the decision is the one rule table — its evidence names the inputs, never the error', () => {
    const { record } = observedRecord(
      readObservedReport({
        target: 'x',
        attempt: 1,
        of: 2,
        outcome: 'failed',
        durationMs: 1,
        error: new Error('pw=1'),
      }),
      { series: 's', now, serve },
    );
    expect(record.decision.chosen).toBe('retry');
    expect(record.decision.default).toBe('retry');
    expect(JSON.stringify(record.decision)).not.toContain('pw=1');
  });
});

describe('attempt/observed · ObservedSeriesBook', () => {
  it('a growing attempt number continues its target’s series; a repeat or a new target opens one', () => {
    let opened = 0;
    const book = new ObservedSeriesBook(() => `s${++opened}`);
    const r = (target: string, attempt: number) =>
      book.seriesFor(readObservedReport({ target, attempt, outcome: 'failed', durationMs: 1 }));
    expect([r('stripe', 1), r('stripe', 2), r('stripe', 3)]).toEqual(['s1', 's1', 's1']);
    expect(r('openai', 1)).toBe('s2');
    expect(r('stripe', 1)).toBe('s3'); // the SDK started a new call
    expect(r('stripe', 2)).toBe('s3');
    expect(r('openai', 2)).toBe('s2');
  });

  it('remembers a bounded number of names — past it, each report opens its own series', async () => {
    const { MAX_OPEN_OBSERVED_SERIES } = await import('../../../../src/lib/attempt/observed.js');
    let opened = 0;
    const book = new ObservedSeriesBook(() => `s${++opened}`);
    const r = (target: string, attempt: number) =>
      book.seriesFor(readObservedReport({ target, attempt, outcome: 'failed', durationMs: 1 }));
    for (let i = 0; i < MAX_OPEN_OBSERVED_SERIES; i++) r(`t${i}`, 1);
    expect(r('t0', 2)).toBe('s1'); // a remembered name still continues
    const past = r('extra', 1);
    expect(r('extra', 2)).not.toBe(past); // past the bound: not remembered
  });

  it('a different source is a different series for the same target', () => {
    let opened = 0;
    const book = new ObservedSeriesBook(() => `s${++opened}`);
    const sdk = book.seriesFor(readObservedReport({ target: 't', attempt: 1, outcome: 'failed', durationMs: 1 }));
    const proxy = book.seriesFor(
      readObservedReport({ target: 't', source: 'proxy', attempt: 2, outcome: 'failed', durationMs: 1 }),
    );
    expect(sdk).not.toBe(proxy);
  });
});

// ── runCall over a hand-made host ────────────────────────────────────────────

interface FakeHost extends CallHost {
  reported: AttemptRecord[];
  refusedCount: number;
  observedReports: Array<{ report: ObservedAttempt; ended: boolean }>;
  live: boolean;
  committed: boolean;
}

function fakeHost(over: Partial<CallHost> = {}): FakeHost {
  const host: FakeHost = {
    series: 'stage#1@1.1',
    reported: [],
    refusedCount: 0,
    observedReports: [],
    live: true,
    committed: false,
    admits(cut) {
      return !host.committed && (cut || host.live);
    },
    serve: (error) => extractErrorInfo(error),
    report(record) {
      host.reported.push(record);
    },
    refused() {
      host.refusedCount += 1;
    },
    observe(report, at) {
      host.observedReports.push({ report, ended: at.ended });
    },
    ...over,
  };
  return host;
}

describe('attempt/call · runCall', () => {
  it('a single call (attempts: 1) still makes ONE record — kind call, its target and series', async () => {
    const host = fakeHost();
    await expect(runCall('stripe.quotes.create', () => 42, { attempts: 1 }, host)).resolves.toBe(42);
    expect(host.reported).toHaveLength(1);
    expect(host.reported[0]).toMatchObject({
      series: 'stage#1@1.1',
      kind: 'call',
      target: 'stripe.quotes.create',
      attempt: 1,
      of: 1,
      outcome: 'ok',
      next: 'done',
      reason: 'succeeded',
    });
  });

  it('retries under the policy; every attempt is reported, in order', async () => {
    const host = fakeHost();
    let calls = 0;
    const value = await runCall(
      'inventory',
      () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error(`busy ${calls}`), { status: 503 });
        return 'ok';
      },
      { attempts: 3 },
      host,
    );
    expect(value).toBe('ok');
    expect(host.reported.map((r) => [r.attempt, r.outcome, r.category, r.next])).toEqual([
      [1, 'failed', 'server', 'retry'],
      [2, 'failed', 'server', 'retry'],
      [3, 'ok', undefined, 'done'],
    ]);
  });

  it('the call’s own cap times an attempt out; the engine stops waiting', async () => {
    const host = fakeHost();
    const started = Date.now();
    await expect(
      runCall('slow', () => new Promise(() => undefined), { attempts: 1, timeoutMs: 20 }, host),
    ).rejects.toThrow(/ran out of its 20ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(host.reported[0]).toMatchObject({ outcome: 'timeout', category: 'timeout', timeoutMs: 20 });
  });

  it('runs under the host’s deadline: the cap is the time left, and a wait that would not fit is not started', async () => {
    const host = fakeHost({ deadline: Date.now() + 40 });
    await expect(
      runCall(
        'slow',
        () => {
          throw new Error('no');
        },
        { attempts: 5, backoffMs: 1_000 },
        host,
      ),
    ).rejects.toThrow('no');
    expect(host.reported).toHaveLength(1);
    expect(host.reported[0]).toMatchObject({ next: 'stop', reason: 'no-time-left', delayMs: 1_000 });
    expect(host.reported[0].timeLeftMs).toBeLessThanOrEqual(40);
  });

  it('a call cut by its stage attempt’s end is recorded (the cut is evidence) and stops — timed out, not aborted', async () => {
    const stage = new AbortController();
    const host = fakeHost({ signal: stage.signal });
    const pending = runCall(
      'slow',
      (t: AttemptContext) =>
        new Promise((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason))),
      { attempts: 3 },
      host,
    );
    // The stage attempt ends at its cap (a time limit, branded like the deadline) — the fence closes first.
    host.live = false;
    stage.abort(deadlineReason('the stage attempt ran out of its 10ms'));
    await expect(pending).rejects.toThrow(/ran out/);
    expect(host.reported).toHaveLength(1);
    expect(host.reported[0]).toMatchObject({ outcome: 'timeout', category: 'timeout', next: 'stop' });
    expect(host.refusedCount).toBe(0);
  });

  it('ONE deadline source: with a host signal, the call never arms a timer of its own for the host’s deadline', async () => {
    // The host's signal is what ends its attempt at its deadline. A second timer for the same instant could fire
    // first and end the call with a reason of its own — failing the stage instead of timing it out (a flake seen
    // under load). Here the host's signal aborts well AFTER the deadline it states: the call must wait for it.
    const stage = new AbortController();
    const stageReason = deadlineReason('the stage attempt ran out of its cap');
    const host = fakeHost({ signal: stage.signal, deadline: Date.now() + 5 });
    const pending = runCall(
      'slow',
      (t: AttemptContext) =>
        new Promise((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason))),
      { attempts: 1 },
      host,
    );
    setTimeout(() => {
      host.live = false;
      stage.abort(stageReason);
    }, 40);
    await expect(pending).rejects.toBe(stageReason);
    expect(host.reported[0]).toMatchObject({ outcome: 'timeout', category: 'timeout' });
  });

  it('a host with a deadline and NO signal: the call arms its own timer, so the deadline still ends it', async () => {
    const host = fakeHost({ deadline: Date.now() + 15 });
    const started = Date.now();
    await expect(
      runCall(
        'slow',
        (t: AttemptContext) =>
          new Promise((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason))),
        { attempts: 3 },
        host,
      ),
    ).rejects.toThrow(/ran out of time/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(host.reported).toHaveLength(1);
    expect(host.reported[0]).toMatchObject({ outcome: 'timeout', next: 'stop', reason: 'no-time-left' });
  });

  it('the run’s cancellation cuts the call: aborted, and the series stops', async () => {
    const run = new AbortController();
    const host = fakeHost({ signal: run.signal });
    const pending = runCall(
      'slow',
      (t: AttemptContext) =>
        new Promise((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason))),
      { attempts: 3 },
      host,
    );
    run.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(host.reported.map((r) => [r.outcome, r.next, r.reason])).toEqual([['aborted', 'stop', 'aborted']]);
  });

  it('a completion that arrives after the stage attempt ended is REFUSED, and no further attempt starts', async () => {
    const host = fakeHost();
    let calls = 0;
    let release!: () => void;
    const pending = runCall(
      'charge',
      () => {
        calls += 1;
        return new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error('gateway 503'));
        });
      },
      { attempts: 5 },
      host,
    );
    // The stage attempt ends (it threw elsewhere) while the call is in flight; its signal did not abort.
    host.live = false;
    release();
    await expect(pending).rejects.toThrow('gateway 503');
    expect(calls).toBe(1); // no retry of an outside call after its stage attempt ended
    expect(host.reported).toEqual([]);
    expect(host.refusedCount).toBe(1);
  });

  it('a record that arrives after the stage committed is refused', async () => {
    const stage = new AbortController();
    const host = fakeHost({ signal: stage.signal });
    let finish!: () => void;
    const pending = runCall(
      'x',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      { attempts: 1 },
      host,
    );
    host.committed = true;
    finish();
    await pending;
    expect(host.reported).toEqual([]);
    expect(host.refusedCount).toBe(1);
  });

  it('a signal already aborted at the start: no attempt is made, nothing is recorded', async () => {
    const run = new AbortController();
    run.abort(new Error('already cancelled'));
    const host = fakeHost({ signal: run.signal });
    let called = false;
    await expect(
      runCall(
        'x',
        () => {
          called = true;
        },
        { attempts: 3 },
        host,
      ),
    ).rejects.toThrow('already cancelled');
    expect(called).toBe(false);
    expect(host.reported).toEqual([]);
  });

  it('`t.observed()` goes to the host, with whether the call attempt had ended', async () => {
    const host = fakeHost();
    let held!: AttemptContext;
    await runCall(
      'x',
      (t: AttemptContext) => {
        held = t;
        t.observed({ target: 'sdk-x', attempt: 1, outcome: 'failed', durationMs: 3 });
      },
      { attempts: 1 },
      host,
    );
    held.observed({ target: 'sdk-x', attempt: 2, outcome: 'ok', durationMs: 3 });
    expect(host.observedReports.map((o) => [o.report.attempt, o.ended])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});
