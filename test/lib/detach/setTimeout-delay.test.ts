/**
 * createSetTimeoutDriver({ delayMs }) — the batch delay is armed by the one long-timer law
 * (`attempt/longTimeout.ts · setLongTimeout`), and a delay that is not a finite number is refused when the driver is
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
  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, '10'])(
    'refuses a delayMs of %o, naming the field',
    (delayMs) => {
      expect(() => createSetTimeoutDriver({ delayMs: delayMs as number })).toThrow(RangeError);
      expect(() => createSetTimeoutDriver({ delayMs: delayMs as number })).toThrow(/delayMs/);
    },
  );
});
