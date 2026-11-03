import { describe, expect, it } from 'vitest';

import type { BoundRun, OwnedRun, RunLifecycle } from '../../../src';
import { createRunLifecycle, flowChart, RunInFlightError } from '../../../src';

function deferred<T = void>() {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe('native run lifecycle', () => {
  it('keeps one admission through native execution, postchecks and cleanup', async () => {
    const started = deferred();
    const stage = deferred();
    const cleanup = deferred();
    const cleaning = deferred();
    let bound!: BoundRun;
    let handle!: OwnedRun;
    const chart = flowChart<{ done?: boolean }>(
      'work',
      async (scope) => {
        bound = owner.forScope(scope);
        started.resolve();
        await stage.promise;
        scope.done = true;
      },
      'work',
    ).build();
    const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'worker' });
    const count = owner.slot<number>('runtime');
    const first = owner.withRun(async (run) => {
      handle = run;
      run.set(count, 1);
      run.onFinalize(async () => {
        cleaning.resolve();
        await cleanup.promise;
      });
      await run.execute({ kind: 'run' });
      expect(run.snapshot()!.sharedState.done).toBe(true);
      run.set(count, 2);
      return 'answer';
    });
    await started.promise;
    expect(bound.origin.kind).toBe('stage');
    expect(bound.origin.runId).toBe(handle.origin!.runId);
    expect(bound.read(count)).toEqual({ present: true, value: 1 });
    expect(owner.view()!.phase).toBe('executing');
    await expect(owner.withRun(() => undefined)).rejects.toMatchObject({
      name: 'RunInFlightError',
      code: 'ERR_RUN_IN_FLIGHT',
      runnerId: 'worker',
      activeRunId: handle.origin!.runId,
    });
    stage.resolve();
    await cleaning.promise;
    expect(handle.read(count)).toEqual({ present: true, value: 2 });
    expect(() => handle.set(count, 3)).toThrow('body has closed');
    await expect(owner.withRun(() => undefined)).rejects.toBeInstanceOf(RunInFlightError);
    cleanup.resolve();
    expect(await first).toBe('answer');
    expect(bound.retired).toBe(true);
    expect(bound.read(count)).toEqual({ present: true, value: 2 });
    expect(() => bound.set(count, 4)).toThrow('retired');
    expect(() => handle.read(count)).toThrow('retired');
    expect(owner.view()!.phase).toBe('settled');
    expect(owner.view()!.snapshot()!.sharedState.done).toBe(true);
  });

  it('joins an execute promise omitted by the body', async () => {
    const entered = deferred();
    const gate = deferred();
    const chart = flowChart(
      'work',
      async () => {
        entered.resolve();
        await gate.promise;
      },
      'work',
    ).build();
    const owner = createRunLifecycle(chart, { runnerId: 'join' });
    let handle!: OwnedRun;
    let returned = false;
    const first = owner
      .withRun((run) => {
        handle = run;
        run.execute({ kind: 'run' });
        return 7;
      })
      .then((value) => {
        returned = true;
        return value;
      });
    try {
      await entered.promise;
      expect(returned).toBe(false);
      expect(() => handle.onFinalize(() => undefined)).toThrow('body has closed');
      await expect(owner.withRun(() => undefined)).rejects.toBeInstanceOf(RunInFlightError);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(returned).toBe(false);
      await expect(owner.withRun(() => undefined)).rejects.toBeInstanceOf(RunInFlightError);
    } finally {
      gate.resolve();
    }
    expect(await first).toBe(7);
  });

  it('distinguishes absent and undefined, consumes cells and rejects recursive initialization', async () => {
    const chart = flowChart('work', async () => undefined, 'work').build();
    const owner = createRunLifecycle(chart, { runnerId: 'cells' });
    const value = owner.slot<number | undefined>('runtime');
    const failed = owner.slot<number>('leg');
    await owner.withRun((run) => {
      expect(run.read(value)).toEqual({ present: false });
      run.set(value, undefined);
      expect(run.read(value)).toEqual({ present: true, value: undefined });
      expect(run.local(value, () => 9)).toBeUndefined();
      expect(run.take(value)).toEqual({ present: true, value: undefined });
      expect(run.take(value)).toEqual({ present: false });
      const original = new Error('initializer');
      expect(() =>
        run.local(failed, () => {
          throw original;
        }),
      ).toThrow(original);
      expect(run.read(failed)).toEqual({ present: false });
      expect(() => run.local(failed, () => run.local(failed, () => 2))).toThrow('being initialized');
      expect(run.local(failed, () => 3)).toBe(3);
    });
    await owner.withRun((run) => {
      expect(run.read(value)).toEqual({ present: false });
      expect(run.read(failed)).toEqual({ present: false });
    });
  });

  it('reserves before origin setup and never invents a preparing run id', async () => {
    const chart = flowChart('work', async () => undefined, 'work').build();
    const owner = createRunLifecycle(chart, { runnerId: 'setup' });
    let collision!: Promise<unknown>;
    await owner.withRun(async (run) => {
      expect(run.origin).toBeUndefined();
      collision = owner.withRun(() => {
        throw new Error('must not enter');
      });
      await expect(collision).rejects.toMatchObject({ code: 'ERR_RUN_IN_FLIGHT' });
      await collision.catch((error: RunInFlightError) => expect(Object.hasOwn(error, 'activeRunId')).toBe(false));
      await run.execute(
        { kind: 'run' },
        {
          onOrigin: (_cells, origin) => {
            expect(origin.kind).toBe('leg');
            expect(run.origin).toBe(origin);
            expect(run.snapshot()).toBeUndefined();
          },
        },
      );
    });
  });

  it('contains and joins an unsupported asynchronous origin initializer', async () => {
    const entered = deferred();
    const gate = deferred();
    let stages = 0;
    let expired: unknown;
    const chart = flowChart(
      'work',
      async () => {
        stages += 1;
      },
      'work',
    ).build();
    const owner = createRunLifecycle(chart, { runnerId: 'async-setup' });
    const value = owner.slot<number>('runtime');
    const first = owner.withRun(async (run) => {
      await run.execute(
        { kind: 'run' },
        {
          onOrigin: async (cells) => {
            entered.resolve();
            await gate.promise;
            try {
              cells.set(value, 1);
            } catch (error) {
              expired = error;
            }
          },
        },
      );
    });
    // Observe the public result while the invalid initializer remains pending.
    let resultSettled = false;
    const settled = first.then(
      () => {
        resultSettled = true;
        return 'fulfilled';
      },
      (error: unknown) => {
        resultSettled = true;
        return error;
      },
    );
    try {
      await entered.promise;
      await expect(owner.withRun(() => undefined)).rejects.toBeInstanceOf(RunInFlightError);
      expect(stages).toBe(0);
      // Let the failed native setup and finite cleanup microtasks finish. The
      // unsupported initializer is still held, so ownership must remain live.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(resultSettled).toBe(false);
      await expect(owner.withRun(() => undefined)).rejects.toBeInstanceOf(RunInFlightError);
    } finally {
      gate.resolve();
    }
    expect(await settled).toBeInstanceOf(TypeError);
    expect(expired).toBeInstanceOf(TypeError);
    expect(stages).toBe(0);
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(stages).toBe(1);
  });

  it('preserves the body failure and continues all cleanups in reverse order', async () => {
    const owner = createRunLifecycle(flowChart('work', async () => undefined, 'work').build(), { runnerId: 'cleanup' });
    const order: string[] = [];
    const original = new Error('body');
    const result = owner.withRun((run) => {
      run.onFinalize(() => {
        order.push('first');
      });
      run.onFinalize(() => {
        order.push('second');
        throw new Error('cleanup');
      });
      throw original;
    });
    await expect(result).rejects.toBe(original);
    expect(order).toEqual(['second', 'first']);
    const rejectUnknown = async (reason: unknown): Promise<never> => {
      throw reason;
    };
    await expect(owner.withRun(() => rejectUnknown(undefined))).rejects.toBeUndefined();
    expect(await owner.withRun(() => 'released')).toBe('released');
  });
});
