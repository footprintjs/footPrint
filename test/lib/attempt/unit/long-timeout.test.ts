/**
 * `attempt/longTimeout.ts · setLongTimeout` — the ONE long-timer law: every limit the library waits out (an attempt's
 * cap, the wait between attempts, the run's deadline, `drainObservers`, `flushAllDetached`) is armed here.
 *
 * WHY: a host timer holds at most 2^31 − 1 ms and Node turns a longer delay — `Infinity` included — into 1 ms. A limit
 * the caller meant as "wait as long as it takes" must arm nothing; a limit past what one timer holds must be waited in
 * full.
 *
 * Test types: Unit (a finite limit fires on time; cancel stops it) · Boundary (`Infinity` arms nothing and never fires;
 * 2^31 fires exactly at 2^31, never early; `0`, a negative, `-Infinity` and `NaN` are due at once; a cancel between
 * chunks holds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLongTimeout } from '../../../../src/lib/attempt/longTimeout.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setLongTimeout — no limit arms nothing', () => {
  it('Infinity arms no host timer and never fires', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi.fn();
    const cancel = setLongTimeout(fn, Infinity);
    expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    expect(() => cancel()).not.toThrow();
  });
});

describe('setLongTimeout — a long limit is waited in full', () => {
  it('2^31 ms fires at 2^31 ms, not after 1 ms and not 1 ms early', () => {
    const fn = vi.fn();
    setLongTimeout(fn, 2 ** 31);
    vi.advanceTimersByTime(1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('every host timer it arms holds at most 2^31 − 1 ms', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    setLongTimeout(() => undefined, 3 * MAX_TIMER_MS + 5);
    vi.advanceTimersByTime(3 * MAX_TIMER_MS + 5);
    const delays = spy.mock.calls.map(([, ms]) => ms as number);
    expect(delays).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, MAX_TIMER_MS, 5]);
  });

  it('a cancel between chunks stops it', () => {
    const fn = vi.fn();
    const cancel = setLongTimeout(fn, 2 * MAX_TIMER_MS);
    vi.advanceTimersByTime(MAX_TIMER_MS + 10);
    cancel();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('setLongTimeout — a finite limit behaves as setTimeout does', () => {
  it('fires once the limit passes, not before', () => {
    const fn = vi.fn();
    setLongTimeout(fn, 250);
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a cancel before the limit stops it and releases the timer', () => {
    const fn = vi.fn();
    const cancel = setLongTimeout(fn, 250);
    cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -5, Number.NEGATIVE_INFINITY, Number.NaN])('%s is already due: it fires on the next timer turn', (ms) => {
    const fn = vi.fn();
    setLongTimeout(fn, ms);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('setLongTimeout — unref', () => {
  /** The host timers `setTimeout` handed back while `run` ran. */
  const armedBy = (run: () => void) => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    run();
    return spy.mock.results.map((result) => result.value as { hasRef(): boolean });
  };

  it('{ unref: true } unrefs every host timer it arms, chunks included — a bound alone keeps no process alive', () => {
    const timers = armedBy(() => {
      setLongTimeout(() => undefined, 2 * MAX_TIMER_MS + 1, { unref: true });
      vi.advanceTimersByTime(2 * MAX_TIMER_MS);
    });
    expect(timers).toHaveLength(3);
    expect(timers.map((timer) => timer.hasRef())).toEqual([false, false, false]);
  });

  it('by default a timer keeps its ref, as the engine’s own limits do', () => {
    const [timer] = armedBy(() => {
      setLongTimeout(() => undefined, 250);
    });
    expect(timer.hasRef()).toBe(true);
  });
});
