import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { OwnedRun } from '../../../src';
import { createRunLifecycle, flowChart, FlowChartExecutor, RunInFlightError } from '../../../src';

function deferred() {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe('run lifecycle boundaries', () => {
  it('a zero-execution admission never relabels the last actual run', async () => {
    const owner = createRunLifecycle(
      flowChart<{ done?: boolean }>(
        'work',
        async (scope) => {
          scope.done = true;
        },
        'work',
      ).build(),
      { runnerId: 'zero' },
    );
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    const actual = owner.view()!;
    await owner.withRun((run) => {
      expect(run.origin).toBeUndefined();
      expect(run.snapshot()).toBeUndefined();
      expect(owner.view()!.origin).toBeUndefined();
      expect(owner.view()!.snapshot()).toBeUndefined();
    });
    expect(owner.view()).toBe(actual);
    expect(actual.snapshot()!.sharedState.done).toBe(true);
  });

  it('refuses duplicate and escaped execution capabilities', async () => {
    let count = 0;
    let escaped!: OwnedRun;
    const owner = createRunLifecycle(
      flowChart(
        'work',
        async () => {
          count += 1;
        },
        'work',
      ).build(),
      { runnerId: 'once' },
    );
    await owner.withRun(async (run) => {
      escaped = run;
      await run.execute({ kind: 'run' });
      expect(() => run.execute({ kind: 'run' })).toThrow('one execution');
    });
    expect(count).toBe(1);
    expect(() => escaped.execute({ kind: 'run' })).toThrow('retired');
    expect(() => escaped.onFinalize(() => undefined)).toThrow('retired');
    expect(() => escaped.snapshot()).toThrow('retired');
    expect(() => owner.slot('leg')).toThrow('before the first use');
  });

  it('propagates an ignored native rejection and releases its next admission', async () => {
    const original = new Error('native failure');
    const owner = createRunLifecycle(
      flowChart(
        'work',
        async () => {
          throw original;
        },
        'work',
      ).build(),
      { runnerId: 'reject' },
    );
    await expect(
      owner.withRun((run) => {
        run.execute({ kind: 'run' });
        return 'body returned';
      }),
    ).rejects.toBe(original);
    await expect(owner.withRun(() => 'released')).resolves.toBe('released');
  });

  it('preserves the body error over failed native setup and a secondary control rejection', async () => {
    const body = new Error('body failure');
    const native = new Error('native failure');
    let stages = 0;
    const owner = createRunLifecycle(
      flowChart(
        'work',
        async () => {
          stages += 1;
        },
        'work',
      ).build(),
      { runnerId: 'both' },
    );
    await expect(
      owner.withRun((run) => {
        run.execute({ kind: 'run' }, { onOrigin: () => Promise.reject(native) });
        throw body;
      }),
    ).rejects.toBe(body);
    expect(stages).toBe(0);
    await expect(owner.withRun(() => 'released')).resolves.toBe('released');
  });

  it.each(['raw', 'facade'] as const)('keeps %s ownership until its recorded sink flush settles', async (shape) => {
    const flushing = deferred();
    const gate = deferred();
    const sink = {
      ...memorySink(),
      flush: async () => {
        flushing.resolve();
        await gate.promise;
      },
    };
    const chart = flowChart<{ value?: number }>(
      'work',
      async (scope) => {
        scope.value = 1;
      },
      'work',
    ).build();
    const raw = new FlowChartExecutor(chart, { sink });
    const owner = createRunLifecycle(chart, { runnerId: 'recorded', executorOptions: { sink } });
    const first =
      shape === 'raw'
        ? raw.run()
        : owner.withRun((run) => {
            run.execute({ kind: 'run' });
          });
    await flushing.promise;
    const intrusion = (shape === 'raw' ? raw.run() : owner.withRun(() => undefined)).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    // Admission happens synchronously. Release the held flush before inspecting
    // the intrusion so a broken guard fails an assertion instead of hanging.
    gate.resolve();
    const result = await intrusion;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toBeInstanceOf(RunInFlightError);
    await first;
  });

  it('preserves inline evidence and per-recorder deferred delivery', async () => {
    let inline = 0;
    let deferredCount = 0;
    const chart = flowChart(
      'emit',
      async (scope) => {
        scope.$emit('sample', { value: 1 });
        expect(inline).toBe(1);
        expect(deferredCount).toBe(0);
      },
      'emit',
    ).build();
    const owner = createRunLifecycle(chart, { runnerId: 'mixed' });
    await owner.withRun((run) =>
      run.execute(
        { kind: 'run' },
        {
          attachments: [
            {
              recorder: {
                id: 'inline-evidence',
                onEmit: () => {
                  inline += 1;
                },
              },
            },
            {
              recorder: {
                id: 'deferred-observer',
                onEmit: () => {
                  deferredCount += 1;
                },
              },
              options: { delivery: 'deferred', capture: 'clone', maxQueue: 8 },
            },
          ],
        },
      ),
    );
    expect(inline).toBe(1);
    expect(deferredCount).toBe(1);
    expect(owner.view()!.snapshot()!.observerStats).toBeDefined();
    expect((await owner.view()!.drainObservers()).pending).toBe(0);
  });

  it.each(['throw', 'reject', 'pending'] as const)(
    'never joins or substitutes a %s diagnostic logger',
    async (mode) => {
      const calls: unknown[][] = [];
      const chart = flowChart('work', async () => undefined, 'work').build();
      chart.logger = {
        info: () => undefined,
        log: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        warn: (...args: unknown[]) => {
          calls.push(args);
          if (mode === 'throw') throw new Error('logger');
          if (mode === 'reject') return Promise.reject(new Error('logger'));
          return new Promise<void>(() => undefined);
        },
      };
      const owner = createRunLifecycle(chart, { runnerId: 'logger' });
      const body = new Error('private-body-marker');
      await expect(
        owner.withRun((run) => {
          run.onFinalize(() => {
            throw new Error('private-cleanup-marker');
          });
          throw body;
        }),
      ).rejects.toBe(body);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls)).not.toContain('private-');
      await expect(owner.withRun(() => 'released')).resolves.toBe('released');
    },
  );

  it('keeps the original error and prior view when setup getters fail before a native origin', async () => {
    let stages = 0;
    const owner = createRunLifecycle(
      flowChart(
        'work',
        async () => {
          stages += 1;
        },
        'work',
      ).build(),
      { runnerId: 'getter' },
    );
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    const previous = owner.view();
    const original = new Error('setup getter');
    await expect(
      owner.withRun((run) =>
        run.execute(
          { kind: 'run' },
          {
            get redaction(): never {
              throw original;
            },
          },
        ),
      ),
    ).rejects.toBe(original);
    expect(stages).toBe(1);
    expect(owner.view()).toBe(previous);
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(stages).toBe(2);
  });
});
