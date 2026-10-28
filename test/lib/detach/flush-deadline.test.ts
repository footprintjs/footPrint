/**
 * detach/flush · flushAllDetached — its limit is a deadline armed by the one long-timer law
 * (`attempt/longTimeout.ts · setLongTimeout`), never a raw `setTimeout`.
 *
 * WHY: `flushAllDetached` handed `timeoutMs - elapsed` straight to `setTimeout`. A host timer holds at most
 * 2^31 − 1 ms and Node turns anything longer — `Infinity` included — into 1 ms, so a shutdown hook that asked to wait
 * for every detached child gave up after about a millisecond with the children still running.
 *
 * Test types: Scenario (`Infinity` waits for the work; 2^31 waits; finite limits behave as before) · Boundary (no
 * limit arms no timer at all; a long limit never reaches `setTimeout` past what a timer holds).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { flushAllDetached } from '../../../src/lib/detach/flush.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';

/** The longest delay a host timer honours. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Work that settles only when released — it arms no timer of its own. */
function gate(): { readonly work: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { work, release: () => release() };
}

/** One detached child whose run is `work` (the microtask driver arms no timer). */
function detach(work: () => Promise<unknown>): void {
  createMicrotaskBatchDriver(() => work()).schedule(fakeChart, undefined, 'child-1');
}

/** The delays a `setTimeout` spy saw that a host timer cannot hold. */
const overflowing = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([, ms]) => ms).filter((ms) => !(typeof ms === 'number' && ms <= MAX_TIMER_MS));

afterEach(() => {
  vi.restoreAllMocks();
  _resetForTests();
  _resetSpawnCounterForTests();
});

describe('flushAllDetached({ timeoutMs }) — no limit and long limits wait for the work', () => {
  it('Infinity arms no timer and waits until every child settles', async () => {
    const pending = gate();
    detach(() => pending.work);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const flushing = flushAllDetached({ timeoutMs: Infinity });
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy).not.toHaveBeenCalled();
    pending.release();
    expect(await flushing).toEqual({ done: 1, failed: 0, pending: 0 });
    expect(size()).toBe(0);
  });

  it('2^31 ms (one past what a timer holds) does not give up after 1 ms', async () => {
    const pending = gate();
    detach(() => pending.work);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const flushing = flushAllDetached({ timeoutMs: 2 ** 31 });
    await wait(20);
    pending.release();
    expect(await flushing).toEqual({ done: 1, failed: 0, pending: 0 });
    expect(overflowing(spy)).toEqual([]);
  });
});

describe('flushAllDetached({ timeoutMs }) — a finite limit behaves as before', () => {
  it('a child that outlasts the limit is reported pending once the limit passes', async () => {
    detach(() => gate().work);
    const started = Date.now();
    const result = await flushAllDetached({ timeoutMs: 20 });
    expect(result).toEqual({ done: 0, failed: 0, pending: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('a child that settles inside the limit is drained', async () => {
    detach(() => wait(10));
    expect(await flushAllDetached({ timeoutMs: 5_000 })).toEqual({ done: 1, failed: 0, pending: 0 });
  });
});
