/**
 * A sink flush's limit is a deadline armed by the one long-timer law (`timers/longTimeout.ts · setLongTimeout`),
 * never a raw `setTimeout`.
 *
 * WHY: `executor.flushRecord({ timeoutMs })` (`runner/recordSink.ts · RunRecord.flush`) and a file sink's
 * `flushTimeoutMs` (`sinks/fileSink.ts · withTimeout`) handed their limit straight to `setTimeout`. A host timer holds
 * at most 2^31 − 1 ms and Node turns a longer delay into 1 ms, so a flush given 2^31 ms was reported pending, or
 * failed, after about a millisecond.
 *
 * Test types: Scenario (a long limit waits for the flush; a finite limit behaves as before) · Boundary (no limit
 * ever reaches `setTimeout` past what a host timer holds).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog, memorySink } from 'foottrace/write';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { fileSink } from '../../../../src/sinks.js';

/** The longest delay a host timer honours. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The delays a `setTimeout` spy saw that a host timer cannot hold. */
const overflowing = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([, ms]) => ms).filter((ms) => !(typeof ms === 'number' && ms <= MAX_TIMER_MS));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const chart = () =>
  flowChart<{ n?: number }>(
    'Count',
    (scope) => {
      scope.n = 1;
    },
    'count',
  ).build();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executor.flushRecord({ timeoutMs }) — a long limit waits for the flush', () => {
  it('2^31 ms waits for a flush that takes 30 ms instead of reporting it pending after 1 ms', async () => {
    const sink = { ...memorySink(), flush: () => wait(30) };
    const executor = new FlowChartExecutor(chart(), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    expect(await executor.flushRecord({ timeoutMs: 2 ** 31 })).toEqual({ done: true, failed: false, pending: false });
    expect(overflowing(spy)).toEqual([]);
  });

  it('a finite limit behaves as before: a stuck flush is reported pending once the limit passes', async () => {
    const sink = { ...memorySink(), flush: () => new Promise<void>(() => undefined) };
    const executor = new FlowChartExecutor(chart(), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    expect(await executor.flushRecord({ timeoutMs: 20 })).toEqual({ done: false, failed: false, pending: true });
  });

  it('Infinity waits for the flush and arms no timer', async () => {
    const sink = { ...memorySink(), flush: () => wait(30) };
    const executor = new FlowChartExecutor(chart(), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const flushing = executor.flushRecord({ timeoutMs: Infinity });
    expect(spy.mock.calls.filter(([, ms]) => ms !== 30)).toEqual([]); // the adapter's own 30 ms work is the only timer
    expect(await flushing).toEqual({ done: true, failed: false, pending: false });
  });
});

describe('executor.flushRecord({ timeoutMs }) — one law, one answer', () => {
  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -1, 0])(
    'a limit of %s names no time: a stuck flush is reported pending at once, as drainObservers does',
    async (timeoutMs) => {
      const sink = { ...memorySink(), flush: () => new Promise<void>(() => undefined) };
      const executor = new FlowChartExecutor(chart(), { sink: { adapter: sink, flush: 'manual' } });
      await executor.run();
      const outcome = await Promise.race([
        executor.flushRecord({ timeoutMs }),
        wait(500).then(() => 'still waiting after 500 ms'),
      ]);
      expect(outcome).toEqual({ done: false, failed: false, pending: true });
    },
  );
});

describe('executor.flushRecord({ timeoutMs }) — a finished flush leaves no timer behind', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a successful finite flush releases its deadline timer — nothing keeps a serverless process alive', async () => {
    let release: () => void = () => undefined;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = { ...memorySink(), flush: () => work };
    const executor = new FlowChartExecutor(chart(), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    vi.useFakeTimers();
    const flushing = executor.flushRecord({ timeoutMs: 30_000 });
    expect(vi.getTimerCount()).toBe(1); // the deadline, armed while the adapter's flush is in flight
    release();
    expect(await flushing).toEqual({ done: true, failed: false, pending: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fileSink({ flushTimeoutMs }) — a long limit waits for the disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fp-flush-deadline-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('2^31 ms waits for a flush no disk finishes in 1 ms instead of failing it', async () => {
    const sink = fileSink(join(dir, 'long.jsonl'), { flushTimeoutMs: 2 ** 31, maxQueuedBytes: 64 * 1024 * 1024 });
    const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [] } });
    const pad = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 400; i++) log.note('n', { i, pad }); // ~26 MB queued: no disk drains it in 1 ms
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await expect(sink.flush!()).resolves.toBeUndefined();
    expect(overflowing(spy)).toEqual([]);
    sink.close();
  });

  it("the flush's timer only bounds the wait: it is unref'd, so it never keeps the process alive on its own", async () => {
    const sink = fileSink(join(dir, 'unref.jsonl'));
    const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [] } });
    log.note('n', { i: 1 });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await sink.flush!();
    const timers = spy.mock.results.map((result) => result.value as { hasRef(): boolean });
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.map((timer) => timer.hasRef())).toEqual(timers.map(() => false));
    sink.close();
  });
});
