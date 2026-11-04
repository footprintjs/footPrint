import { describe, expect, it, vi } from 'vitest';

import {
  type ComponentRun,
  type ComponentSetup,
  type InlineComponentRecorder,
  createRunLifecycle,
  flowChart,
  FlowChartExecutor,
  RunInFlightError,
} from '../../../src/index.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('component setup control boundaries', () => {
  it.each(['owned', 'raw', 'mount'] as const)(
    'joins already registered cleanup when a later %s namespace setup fails',
    async (shape) => {
      const primary = new Error('later setup');
      const order: string[] = [];
      const body = vi.fn();
      const child = flowChart('child', body, 'child').build();
      const first = createRunLifecycle(child, {
        runnerId: 'first',
        componentSetup: (component) => {
          component.onFinalize(async (end) => {
            await Promise.resolve();
            order.push('first:' + end.kind);
          });
          return {};
        },
      });
      const second = createRunLifecycle(child, {
        runnerId: 'second',
        componentSetup: (component) => {
          component.onFinalize((end) => {
            order.push('second:' + end.kind);
            throw new Error('cleanup');
          });
          throw primary;
        },
      });
      first.slot('component');
      second.slot('component');
      const run =
        shape === 'owned'
          ? first.withRun((run) => run.execute({ kind: 'run' }))
          : new FlowChartExecutor(
              shape === 'raw'
                ? child
                : flowChart('parent', () => undefined, 'parent')
                    .addSubFlowChartNext('child', child, 'child')
                    .build(),
            ).run();
      await expect(run).rejects.toBe(primary);
      expect(body).not.toHaveBeenCalled();
      expect(order).toEqual(['second:failed', 'first:failed']);
    },
  );

  it('finalizes a mount after an input mapper fails, before parent rejection', async () => {
    const primary = new Error('input');
    const body = vi.fn();
    const cleaned: string[] = [];
    const child = flowChart('child', body, 'child').build();
    const owner = createRunLifecycle(child, {
      runnerId: 'input',
      componentSetup: (component) => {
        component.onFinalize(async (end) => {
          await Promise.resolve();
          cleaned.push(end.kind);
        });
        return {};
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', child, 'child', {
        inputMapper: () => {
          throw primary;
        },
      })
      .build();
    await expect(new FlowChartExecutor(parent).run()).rejects.toBe(primary);
    expect(body).not.toHaveBeenCalled();
    expect(cleaned).toEqual(['failed']);
  });

  it('joins mount cleanup when its seed cannot be cloned', async () => {
    const body = vi.fn();
    const cleanup = vi.fn();
    const child = flowChart('child', body, 'child').build();
    const owner = createRunLifecycle(child, {
      runnerId: 'seed',
      componentSetup: (component) => {
        component.onFinalize(cleanup);
        return {};
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', child, 'child', { inputMapper: () => ({ invalid: () => undefined }) })
      .build();
    await expect(new FlowChartExecutor(parent).run()).rejects.toBeDefined();
    expect(body).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ kind: 'failed' });
  });

  it('joins cleanup after a genuine mount exit commit failure', async () => {
    const body = vi.fn(() => 'answer');
    const ends: string[] = [];
    const child = flowChart('child', body, 'child').build();
    const owner = createRunLifecycle(child, {
      runnerId: 'merge',
      componentSetup: (component) => {
        component.onFinalize((end) => {
          ends.push(end.kind);
        });
        return {};
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', child, 'child', { outputMapper: () => ({ invalid: () => undefined }) })
      .build();
    await expect(new FlowChartExecutor(parent).run()).rejects.toBeDefined();
    expect(body).toHaveBeenCalledTimes(1);
    expect(ends).toEqual(['failed']);
  });

  it('preserves the existing swallowed output-mapper exception policy', async () => {
    const ends: string[] = [];
    const child = flowChart('child', () => 'answer', 'child').build();
    const owner = createRunLifecycle(child, {
      runnerId: 'mapper-policy',
      componentSetup: (component) => {
        component.onFinalize((end) => {
          ends.push(end.kind);
        });
        return {};
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', child, 'child', {
        outputMapper: () => {
          throw new Error('mapper');
        },
      })
      .build();
    await new FlowChartExecutor(parent).run();
    expect(ends).toEqual(['completed']);
  });

  it.each(['raw', 'owned'] as const)('keeps the %s lease until component cleanup settles', async (shape) => {
    const entered = gate();
    const release = gate();
    const chart = flowChart('body', () => 'answer', 'body').build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'cleanup-lease',
      componentSetup: (component) => {
        component.onFinalize(async () => {
          entered.resolve();
          await release.promise;
        });
        return {};
      },
    });
    owner.slot('component');
    const raw = new FlowChartExecutor(chart);
    const first = shape === 'raw' ? raw.run() : owner.withRun((run) => run.execute({ kind: 'run' }));
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let result: { failed: boolean; reason?: unknown };
    try {
      result = await (shape === 'raw' ? raw.run() : owner.withRun(() => undefined)).then(
        () => ({ failed: false }),
        (reason) => ({ failed: true, reason }),
      );
    } finally {
      release.resolve();
      await first;
    }
    expect(result.failed).toBe(true);
    expect(result.reason).toBeInstanceOf(RunInFlightError);
    await (shape === 'raw' ? raw.run() : owner.withRun(() => undefined));
  });

  it('does not continue the parent until the mounted finalizer settles', async () => {
    const entered = gate();
    const release = gate();
    const after = vi.fn();
    const child = flowChart('child', () => 'answer', 'child').build();
    const owner = createRunLifecycle(child, {
      runnerId: 'mount-join',
      componentSetup: (component) => {
        component.onFinalize(async () => {
          entered.resolve();
          await release.promise;
        });
        return {};
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', child, 'child')
      .addFunction('after', after, 'after')
      .build();
    const running = new FlowChartExecutor(parent).run();
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(after).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await running;
    }
    expect(after).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, false, 0, ''] as const)(
    'preserves a falsy primary failure over cleanup failure: %s',
    async (primary) => {
      const chart = flowChart('body', () => 'answer', 'body').build();
      const ends: string[] = [];
      const owner = createRunLifecycle(chart, {
        runnerId: 'precedence',
        componentSetup: (component) => {
          component.onFinalize((end) => {
            ends.push(end.kind);
            throw new Error('secondary');
          });
          return {};
        },
      });
      owner.slot('component');
      await expect(
        owner.withRun(async (run) => {
          await run.execute({ kind: 'run' });
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect(ends).toEqual(['failed']);
      await expect(owner.withRun(() => 'released')).resolves.toBe('released');
    },
  );

  it('keeps owned postprocessing registration open after component mutation retires', async () => {
    let component!: ComponentRun;
    const order: string[] = [];
    const chart = flowChart('body', () => 'answer', 'body').build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'postprocess',
      componentSetup: (value) => {
        component = value;
        value.onFinalize(() => {
          order.push('component');
        });
        return {};
      },
    });
    const slot = owner.slot('component');
    await owner.withRun(async (run) => {
      await run.execute({ kind: 'run' });
      expect(() => component.set(slot, 'late')).toThrow('retired');
      expect(() => component.onFinalize(() => undefined)).toThrow('retired');
      run.onFinalize(() => {
        order.push('postprocess');
      });
    });
    expect(order).toEqual(['postprocess', 'component']);
  });

  it('refuses a binder before streaming starts or stage body runs', async () => {
    const error = new Error('binder');
    const body = vi.fn();
    const onStart = vi.fn();
    const cleanup = vi.fn();
    const chart = flowChart('seed', () => undefined, 'seed')
      .addStreamingFunction('stream', body, 'stream')
      .build();
    let first = true;
    const owner = createRunLifecycle(chart, {
      runnerId: 'stream',
      executorOptions: { streamHandlers: { onStart } },
      componentSetup: (component) => {
        component.onFinalize(cleanup);
        return {
          bindScope: () => {
            if (first) {
              first = false;
              return;
            }
            throw error;
          },
        };
      },
    });
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toBe(error);
    expect(onStart).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ kind: 'failed' });
  });

  it('refuses an asynchronous binder and consumes its native rejection', async () => {
    const body = vi.fn();
    const cleanup = vi.fn();
    const chart = flowChart('body', body, 'body').build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'async-binder',
      componentSetup: (component) => {
        component.onFinalize(cleanup);
        return {
          bindScope: async () => {
            throw new Error('private async rejection');
          },
        };
      },
    });
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toThrow('must be synchronous');
    expect(body).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('captures the live port set before onOrigin declares another namespace', async () => {
    const firstSetup = vi.fn();
    const laterSetup = vi.fn();
    const chart = flowChart('body', () => 'answer', 'body').build();
    const first = createRunLifecycle(chart, {
      runnerId: 'first',
      componentSetup: () => {
        firstSetup();
        return {};
      },
    });
    first.slot('component');
    let later: ReturnType<typeof createRunLifecycle> | undefined;
    await first.withRun((run) =>
      run.execute(
        { kind: 'run' },
        {
          onOrigin: () => {
            later = createRunLifecycle(chart, {
              runnerId: 'later',
              componentSetup: () => {
                laterSetup();
                return {};
              },
            });
            later.slot('component');
          },
        },
      ),
    );
    expect(laterSetup).not.toHaveBeenCalled();
    await first.withRun((run) => run.execute({ kind: 'run' }));
    expect(firstSetup).toHaveBeenCalledTimes(2);
    expect(laterSetup).toHaveBeenCalledTimes(1);
    expect(later).toBeDefined();
  });

  it.each(['inline', undefined] as const)(
    'accepts an inherited own-data delivery of %s on a class recorder',
    async (delivery) => {
      class Recorder {
        readonly id = 'class-recorder';
        readonly onEmit = vi.fn();
      }
      Object.defineProperty(Recorder.prototype, 'delivery', { value: delivery });
      const recorder = new Recorder();
      const chart = flowChart<Record<string, unknown>>(
        'body',
        (scope) => {
          scope.$emit('fixture', {});
        },
        'body',
      ).build();
      const owner = createRunLifecycle(chart, { runnerId: 'class', componentSetup: () => ({ recorder }) });
      owner.slot('component');
      await owner.withRun((run) => run.execute({ kind: 'run' }));
      expect(recorder.onEmit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['deferred', 'unknown', 'accessor'] as const)(
    'refuses inherited %s delivery without getter execution',
    async (value) => {
      const get = vi.fn(() => 'inline');
      const body = vi.fn();
      const prototype = Object.create(null);
      Object.defineProperty(prototype, 'delivery', value === 'accessor' ? { get } : { value });
      const recorder = Object.assign(Object.create(prototype), { id: 'untyped-recorder' }) as InlineComponentRecorder;
      const chart = flowChart('body', body, 'body').build();
      const owner = createRunLifecycle(chart, { runnerId: 'delivery', componentSetup: () => ({ recorder }) });
      owner.slot('component');
      await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toMatchObject({
        code: 'ERR_COMPONENT_RECORDER_DELIVERY',
      });
      expect(get).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    },
  );

  it('refuses a foreign setup then getter without inspecting or invoking it', async () => {
    const then = vi.fn();
    const body = vi.fn();
    const configuration = Object.defineProperty({}, 'then', { get: then });
    const chart = flowChart('body', body, 'body').build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'foreign',
      componentSetup: () => configuration as ComponentSetup,
    });
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toThrow('Unknown or accessor');
    expect(then).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });
  it('does not probe a foreign diagnostic then getter when cleanup fails', async () => {
    const get = vi.fn(() => undefined);
    const returned = Object.defineProperty({}, 'then', { get });
    const primary = new Error('primary');
    const chart = flowChart('body', () => undefined, 'body').build();
    chart.logger = {
      info: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      warn: () => returned,
    };
    const owner = createRunLifecycle(chart, { runnerId: 'diagnostic-then' });
    await expect(
      owner.withRun((run) => {
        run.onFinalize(() => {
          throw new Error('cleanup');
        });
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(get).not.toHaveBeenCalled();
  });
});
