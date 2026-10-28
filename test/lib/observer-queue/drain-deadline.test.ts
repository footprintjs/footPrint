/**
 * DeferredDispatcher · drain — its limit is a deadline armed by the one long-timer law
 * (`attempt/longTimeout.ts · setLongTimeout`), never a raw `setTimeout`.
 *
 * WHY: `drain` handed `timeoutMs - elapsed` straight to `setTimeout`. A host timer holds at most 2^31 − 1 ms and Node
 * turns anything longer — `Infinity` included — into 1 ms, so `executor.drainObservers({ timeoutMs: Infinity })`
 * gave up after about a millisecond and reported work still pending.
 *
 * Test types: Scenario (`Infinity` waits for the work; 2^31 waits; finite limits behave as before) · Boundary (no
 * limit arms no timer at all; a long limit never reaches `setTimeout` past what a timer holds).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeferredDispatcher } from '../../../src/lib/observer-queue/deferredDispatcher';
import type { EnqueueInput } from '../../../src/lib/observer-queue/mergedQueue';

/** The longest delay a host timer honours. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const input: EnqueueInput = {
  channel: 'scope',
  method: 'onWrite',
  runtimeStageId: 'seed#0',
  runId: 'run-1',
  payload: { v: 1 },
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Work that settles only when released — it arms no timer of its own. */
function gate(): { readonly work: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { work, release: () => release() };
}

/** A dispatcher whose one listener returns `work` — the continuation `drain` must settle. */
function dispatcherWith(work: () => Promise<void>): DeferredDispatcher {
  const dispatcher = new DeferredDispatcher();
  dispatcher.addListener('slow', () => work());
  dispatcher.capture(input);
  return dispatcher;
}

/** The delays a `setTimeout` spy saw that a host timer cannot hold. */
const overflowing = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([, ms]) => ms).filter((ms) => !(typeof ms === 'number' && ms <= MAX_TIMER_MS));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drain({ timeoutMs }) — no limit and long limits wait for the work', () => {
  it('Infinity arms no timer and waits until the work settles', async () => {
    const pending = gate();
    const dispatcher = dispatcherWith(() => pending.work);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const draining = dispatcher.drain({ timeoutMs: Infinity });
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy).not.toHaveBeenCalled();
    pending.release();
    expect(await draining).toEqual({ done: 1, failed: 0, pending: 0 });
  });

  it('2^31 ms (one past what a timer holds) does not give up after 1 ms', async () => {
    const pending = gate();
    const dispatcher = dispatcherWith(() => pending.work);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const draining = dispatcher.drain({ timeoutMs: 2 ** 31 });
    await wait(20);
    pending.release();
    expect(await draining).toEqual({ done: 1, failed: 0, pending: 0 });
    expect(overflowing(spy)).toEqual([]);
  });
});

describe('drain({ timeoutMs }) — a finite limit behaves as before', () => {
  it('work that outlasts the limit is reported pending once the limit passes', async () => {
    const dispatcher = dispatcherWith(() => gate().work);
    const started = Date.now();
    const result = await dispatcher.drain({ timeoutMs: 20 });
    expect(result).toEqual({ done: 0, failed: 0, pending: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('work that settles inside the limit drains completely', async () => {
    const dispatcher = dispatcherWith(() => wait(10));
    expect(await dispatcher.drain({ timeoutMs: 5_000 })).toEqual({ done: 1, failed: 0, pending: 0 });
  });

  it('a limit already spent gives up at once', async () => {
    const dispatcher = dispatcherWith(() => gate().work);
    expect(await dispatcher.drain({ timeoutMs: 0 })).toEqual({ done: 0, failed: 0, pending: 1 });
    expect(await dispatcher.drain({ timeoutMs: -5 })).toEqual({ done: 0, failed: 0, pending: 1 });
  });
});
