/**
 * Batched detach scheduling ownership (handoff I).
 *
 * A refused scheduling boundary fails only its own batch; it must not escape to the
 * caller, retain handles, run failed work later, or poison future batches. Controlled
 * callbacks make the scheduling boundaries explicit without timers or long waits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch';
import { createSetImmediateDriver } from '../../../src/lib/detach/drivers/setImmediate';
import { createSetTimeoutDriver } from '../../../src/lib/detach/drivers/setTimeout';
import { flushAllDetached } from '../../../src/lib/detach/flush';
import { _resetForTests, lookup, size } from '../../../src/lib/detach/registry';
import type { ChildRunner } from '../../../src/lib/detach/runChild';
import { detachAndForget, detachAndJoinLater } from '../../../src/lib/detach/spawn';
import type { DetachDriver, DetachHandle } from '../../../src/lib/detach/types';

const child = flowChart('Child', () => {}, 'child').build();
const drivers = [
  { name: 'setImmediate', create: (run: ChildRunner) => createSetImmediateDriver(run) },
  { name: 'setTimeout', create: (run: ChildRunner) => createSetTimeoutDriver({ delayMs: 17, runChild: run }) },
  { name: 'queueMicrotask', create: (run: ChildRunner) => createMicrotaskBatchDriver(run) },
] as const;

type SchedulerName = (typeof drivers)[number]['name'];

function controlledScheduler(name: SchedulerName) {
  const callbacks: (() => void)[] = [];
  const schedule = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal(name, schedule);
  return { callbacks, schedule };
}

async function expectFailed(handle: DetachHandle, id: string, error?: Error): Promise<void> {
  expect(handle.id).toBe(id);
  expect(handle.status).toBe('failed');
  expect(handle.error).toBeInstanceOf(Error);
  if (error) expect(handle.error).toBe(error);
  const wait = handle.wait();
  expect(handle.wait()).toBe(wait);
  await expect(wait).rejects.toBe(handle.error);
  expect(lookup(id)).toBeUndefined();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetForTests();
});

describe.each(drivers)('$name batch scheduling', ({ name, create }) => {
  it.each(['missing', 'non-callable', 'throws'] as const)(
    '%s scheduler returns a failed handle, preserves the Error and leaves nothing to flush',
    async (mode) => {
      const run = vi.fn(async () => 'ok');
      const driver = create(run);
      const failure = new Error('scheduler refused');
      const scheduler =
        mode === 'missing'
          ? undefined
          : mode === 'non-callable'
          ? {}
          : () => {
              throw failure;
            };
      vi.stubGlobal(name, scheduler);

      const handle = driver.schedule(child, undefined, 'failed');

      await expectFailed(handle, 'failed', mode === 'throws' ? failure : undefined);
      expect(run).not.toHaveBeenCalled();
      expect(size()).toBe(0);
      // Terminal failures have already unregistered, so flush need not count them.
      await expect(flushAllDetached()).resolves.toEqual({ done: 0, failed: 0, pending: 0 });
    },
  );

  it('repeated failures do not poison a restored scheduler or run old work', async () => {
    const run = vi.fn(async (_chart, input) => input);
    const driver = create(run);
    const failure = new Error('not now');
    vi.stubGlobal(name, () => {
      throw failure;
    });
    const first = driver.schedule(child, 'old-1', 'first');
    const second = driver.schedule(child, 'old-2', 'second');
    await expectFailed(first, 'first', failure);
    await expectFailed(second, 'second', failure);

    const { callbacks, schedule } = controlledScheduler(name);
    const restored = driver.schedule(child, 'new', 'restored');
    expect(restored.status).toBe('queued');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    callbacks[0]();
    await expect(restored.wait()).resolves.toEqual({ result: 'new' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(size()).toBe(0);
  });

  it('a callback retained by a throwing scheduler cannot run failed work or steal the next batch', async () => {
    const run = vi.fn(async (_chart, input) => input);
    const driver = create(run);
    const failure = new Error('posted then refused');
    let stale: () => void = () => {
      throw new Error('scheduler did not capture its callback');
    };
    vi.stubGlobal(name, (callback: () => void) => {
      stale = callback;
      throw failure;
    });
    const failed = driver.schedule(child, 'old', 'old');
    await expectFailed(failed, 'old', failure);

    const { callbacks } = controlledScheduler(name);
    const next = driver.schedule(child, 'new', 'new');
    stale();
    expect(run).not.toHaveBeenCalled();
    expect(next.status).toBe('queued');
    expect(lookup('new')).toBe(next);
    callbacks[0]();
    await expect(next.wait()).resolves.toEqual({ result: 'new' });
    stale();
    expect(run).toHaveBeenCalledTimes(1);
    expect(failed.status).toBe('failed');
    expect(size()).toBe(0);
  });

  it('a reentrant scheduler failure settles its entire batch but not another driver batch', async () => {
    const run = vi.fn(async (_chart, input) => input);
    const healthyDriver = create(run);
    const healthySchedule = controlledScheduler(name);
    const healthy = healthyDriver.schedule(child, 'healthy', 'healthy');

    const driver = create(run);
    const failure = new Error('reentrant refusal');
    let nested: DetachHandle | undefined;
    const refusedSchedule = vi.fn(() => {
      nested = driver.schedule(child, 'nested', 'nested');
      throw failure;
    });
    vi.stubGlobal(name, refusedSchedule);
    const outer = driver.schedule(child, 'outer', 'outer');

    expect(refusedSchedule).toHaveBeenCalledTimes(1);
    await expectFailed(outer, 'outer', failure);
    if (!nested) throw new Error('scheduler did not append its nested handle');
    await expectFailed(nested, 'nested', failure);
    expect(healthy.status).toBe('queued');
    expect(lookup('healthy')).toBe(healthy);
    expect(size()).toBe(1);
    healthySchedule.callbacks[0]();
    await expect(healthy.wait()).resolves.toEqual({ result: 'healthy' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(size()).toBe(0);
  });

  it('does not silently fall back to another available scheduler', async () => {
    const run = vi.fn(async () => 'unexpected');
    const driver = create(run);
    const alternatives = drivers
      .filter((entry) => entry.name !== name)
      .map((entry) => {
        const schedule = vi.fn();
        vi.stubGlobal(entry.name, schedule);
        return schedule;
      });
    vi.stubGlobal(name, undefined);
    const failed = driver.schedule(child, undefined, 'no-fallback');
    await expectFailed(failed, 'no-fallback');
    for (const schedule of alternatives) expect(schedule).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(size()).toBe(0);
  });

  it('starts a batch in FIFO order without serializing siblings and preserves sibling error isolation', async () => {
    const { callbacks, schedule } = controlledScheduler(name);
    const started: unknown[] = [];
    const completions: ((value: unknown) => void)[] = [];
    const failure = new Error('only bad fails');
    const driver = create((_chart, input) => {
      started.push(input);
      if (input === 'bad') return Promise.reject(failure);
      return new Promise((resolve) => {
        completions.push(resolve);
      });
    });
    const first = driver.schedule(child, 'first', 'first');
    const bad = driver.schedule(child, 'bad', 'bad');
    const last = driver.schedule(child, 'last', 'last');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(started).toEqual([]);
    if (name === 'setTimeout') expect(schedule).toHaveBeenCalledWith(expect.any(Function), 17);
    const failedWait = expect(bad.wait()).rejects.toBe(failure);

    callbacks[0]();
    expect(started).toEqual(['first', 'bad', 'last']);
    expect(first.status).toBe('running');
    expect(last.status).toBe('running');
    completions[1]('last result');
    await expect(last.wait()).resolves.toEqual({ result: 'last result' });
    expect(first.status).toBe('running');
    completions[0]('first result');
    await expect(first.wait()).resolves.toEqual({ result: 'first result' });
    await failedWait;
    expect(size()).toBe(0);
  });

  it('nested child scheduling gets a separate batch while shutdown still drains transitively', async () => {
    const { callbacks, schedule } = controlledScheduler(name);
    const started: unknown[] = [];
    let nested: DetachHandle | undefined;
    const driver: DetachDriver = create(async (_chart, input) => {
      started.push(input);
      if (input === 'parent') nested = driver.schedule(child, 'nested', 'nested');
      return input;
    });
    const parent = driver.schedule(child, 'parent', 'parent');
    const sibling = driver.schedule(child, 'sibling', 'sibling');
    callbacks[0]();
    expect(started).toEqual(['parent', 'sibling']);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(nested?.status).toBe('queued');
    // Restore real timers for flush's deadline; the driver's callbacks remain controlled.
    vi.unstubAllGlobals();
    const drained = flushAllDetached();
    callbacks[1]();
    if (!nested) throw new Error('child did not append its nested handle');
    await Promise.all([parent.wait(), sibling.wait(), nested.wait()]);
    expect((await drained).pending).toBe(0);
    expect(started).toEqual(['parent', 'sibling', 'nested']);
    expect(size()).toBe(0);
  });

  it.each(['scheduler', 'child'] as const)(
    '%s contains failures even when error classification throws',
    async (site) => {
      let reads = 0;
      const classificationError = new Error('classification trap');
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            reads += 1;
            if (reads <= 2) return null;
            if (reads === 3) return Error.prototype;
            throw classificationError;
          },
        },
      );
      const { callbacks } = controlledScheduler(name);
      const driver = create(() => Promise.reject(hostile));
      if (site === 'scheduler')
        vi.stubGlobal(name, () => {
          throw hostile;
        });
      const handle = driver.schedule(child, undefined, 'classification');
      if (site === 'child') {
        callbacks[0]();
        await Promise.resolve();
        await Promise.resolve();
      }
      await expectFailed(handle, 'classification');
      expect(handle.error).not.toBe(classificationError);
      expect(size()).toBe(0);
    },
  );

  it.each(['scheduler', 'child'] as const)(
    '%s safely normalizes a non-Error whose string conversion throws',
    async (site) => {
      const hostile = Object.create(null) as object;
      const conversionError = new Error('conversion trap');
      Object.defineProperty(hostile, Symbol.toPrimitive, {
        value: () => {
          throw conversionError;
        },
      });
      const { callbacks } = controlledScheduler(name);
      const run = vi.fn(() => (site === 'child' ? Promise.reject(hostile) : Promise.resolve('ok')));
      const driver = create(run);
      if (site === 'scheduler') {
        vi.stubGlobal(name, () => {
          // Deliberately exercise arbitrary JavaScript throw values at the host boundary.
          throw hostile;
        });
      }
      const handle = driver.schedule(child, undefined, 'hostile');
      if (site === 'child') {
        callbacks[0]();
        // Await runner rejection and executeOne's catch without awaiting a potentially stuck handle.
        await Promise.resolve();
        await Promise.resolve();
      }
      await expectFailed(handle, 'hostile');
      expect(handle.error).not.toBe(conversionError);
      expect(size()).toBe(0);
    },
  );
});

describe('explicit preflight and public detach surfaces', () => {
  it('setImmediate validate remains an explicit preflight without scheduling or registering work', () => {
    const driver = createSetImmediateDriver(async () => 'ok');
    const { schedule } = controlledScheduler('setImmediate');
    expect(() => driver.validate?.()).not.toThrow();
    expect(schedule).not.toHaveBeenCalled();
    vi.stubGlobal('setImmediate', undefined);
    expect(() => driver.validate?.()).toThrow(/requires Node.js/);
    expect(size()).toBe(0);
  });

  it('the shared entry point does not introduce automatic custom-driver preflight', async () => {
    const { callbacks } = controlledScheduler('queueMicrotask');
    const validate = vi.fn(() => {
      throw new Error('explicit preflight only');
    });
    const driver = { ...createMicrotaskBatchDriver(async () => 'ok'), validate };
    const handle = detachAndJoinLater(driver, child, undefined, 'custom');
    callbacks[0]();
    await expect(handle.wait()).resolves.toEqual({ result: 'ok' });
    expect(validate).not.toHaveBeenCalled();
    expect(size()).toBe(0);
  });

  it.each(['spawn', 'executor', 'scope', 'builder'] as const)(
    '%s join and forget contain unavailable-scheduler failures and allow the parent to continue',
    async (surface) => {
      const run = vi.fn(async () => 'unexpected');
      const driver = createSetImmediateDriver(run);
      const handles: DetachHandle[] = [];
      vi.stubGlobal('setImmediate', undefined);
      let chart = flowChart<{ continued: boolean }>(
        'Parent',
        (scope) => {
          if (surface === 'spawn') {
            handles.push(detachAndJoinLater(driver, child, undefined, 'caller'));
            detachAndForget(driver, child, undefined, 'caller');
          } else if (surface === 'scope') {
            handles.push(scope.$detachAndJoinLater(driver, child, undefined));
            scope.$detachAndForget(driver, child, undefined);
          }
          scope.continued = false;
        },
        'parent',
      );
      if (surface === 'builder') {
        chart = chart
          .addDetachAndJoinLater('join', child, {
            driver,
            onHandle: (handle) => {
              handles.push(handle);
            },
          })
          .addDetachAndForget('forget', child, { driver });
      }
      chart.addFunction(
        'After',
        (scope) => {
          scope.continued = true;
        },
        'after',
      );
      const executor = new FlowChartExecutor(chart.build());
      if (surface === 'executor') {
        handles.push(executor.detachAndJoinLater(driver, child, undefined));
        executor.detachAndForget(driver, child, undefined);
      }
      await executor.run();
      expect(executor.getSnapshot().sharedState.continued).toBe(true);
      expect(handles).toHaveLength(1);
      await expectFailed(handles[0], handles[0].id);
      expect(run).not.toHaveBeenCalled();
      expect(size()).toBe(0);
    },
  );
});
