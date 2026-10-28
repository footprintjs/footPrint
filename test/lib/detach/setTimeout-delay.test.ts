/**
 * createSetTimeoutDriver({ delayMs }) — the batch delay is armed by the one long-timer law
 * (`timers/longTimeout.ts · setLongTimeout`), and a delay that is not a finite number is refused when the driver is
 * made.
 *
 * WHY: the driver handed `delayMs` straight to `setTimeout`, which Node turns into 1 ms past 2^31 − 1 ms, so a
 * 25-day batching delay ran its children at once. `Infinity` and `NaN` were silently the same 1 ms; under the law
 * `Infinity` would never run them at all, so a delay that is not a finite number is refused instead.
 *
 * Test types: Scenario (a long delay is waited in full; a finite delay behaves as before) · Boundary (refusals name
 * the field; a negative delay waits nothing, as the host's timer does). Fake timers model Node's overflow: a raw
 * `setTimeout` of 2^31 ms fires after 1 ms there too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createSetTimeoutDriver } from '../../../src/lib/detach/drivers/setTimeout.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  _resetForTests();
  _resetSpawnCounterForTests();
});

/** A driver with `delayMs` and a child that records when it runs. */
function driverWith(delayMs: number) {
  const runChild = vi.fn(async () => 'ok');
  const driver = createSetTimeoutDriver({ delayMs, runChild });
  return { driver, runChild };
}

describe('createSetTimeoutDriver({ delayMs }) — the delay is waited as declared', () => {
  it('a delay of 2^31 ms is waited in full, not cut to 1 ms', async () => {
    const { driver, runChild } = driverWith(2 ** 31);
    driver.schedule(fakeChart, undefined, 'late-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runChild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('a finite delay behaves as before: the batch runs once it passes', async () => {
    const { driver, runChild } = driverWith(50);
    driver.schedule(fakeChart, undefined, 'soon-1');
    await vi.advanceTimersByTimeAsync(49);
    expect(runChild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('a negative delay waits nothing, as the host timer does', async () => {
    const { driver, runChild } = driverWith(-5);
    driver.schedule(fakeChart, undefined, 'now-1');
    await vi.advanceTimersByTimeAsync(1);
    expect(runChild).toHaveBeenCalledTimes(1);
  });
});

describe('createSetTimeoutDriver({ delayMs }) — a delay that is not a finite number is refused', () => {
  /** The error making the driver throws — the test fails when it throws nothing. */
  const refusal = (delayMs: unknown): Error => {
    try {
      createSetTimeoutDriver({ delayMs: delayMs as number });
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a refusal');
  };

  it.each([
    [Number.POSITIVE_INFINITY, RangeError],
    [Number.NEGATIVE_INFINITY, RangeError],
    [Number.NaN, RangeError],
    ['10', TypeError],
    [{ valueOf: () => 10 }, TypeError],
  ])('refuses a delayMs of %o by the field name and the expected shape — never the value', (delayMs, kind) => {
    const error = refusal(delayMs);
    expect(error).toBeInstanceOf(kind);
    expect(error.message).toBe('createSetTimeoutDriver: delayMs must be a finite number of milliseconds');
  });

  it('never echoes the value it refuses', () => {
    expect(refusal('not-a-real-secret-0123456789').message).not.toMatch(/not-a-real-secret/);
  });

  it('an absent delay — undefined or null — is the default 0, as it always was', () => {
    expect(() => createSetTimeoutDriver({ delayMs: undefined })).not.toThrow();
    expect(() => createSetTimeoutDriver({ delayMs: null as unknown as number })).not.toThrow();
    expect(createSetTimeoutDriver({ delayMs: null as unknown as number }).name).toBe('set-timeout');
  });
});
