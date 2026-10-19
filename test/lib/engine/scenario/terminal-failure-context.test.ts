import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { FlowErrorEvent, FlowRunFailedEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt, UnknownEffectError } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('terminal context at executor settlement boundaries', () => {
  it.each(['run', 'resume'] as const)(
    'a concurrent %s refusal preserves the original in-flight leg',
    async (method) => {
      const entered = deferred();
      const release = deferred();
      const original = Object.assign(new Error('synthetic in-flight failure'), { status: 503 });
      const executor = new FlowChartExecutor(
        flowChart(
          'In flight',
          async () => {
            entered.resolve();
            await release.promise;
            throw original;
          },
          'in-flight',
        )
          .setLogger(silent)
          .build(),
      );
      const failed: FlowRunFailedEvent[] = [];
      executor.attachFlowRecorder({ id: 'in-flight-owner', onRunFailed: (event) => failed.push(event) });
      const pending = executor.run().then(
        () => ({ resolved: true }),
        (value: unknown) => ({ value }),
      );
      try {
        await entered.promise;
        const runId = executor.getSnapshot().runId;
        await expect(method === 'run' ? executor.run() : executor.resume({} as never, {})).rejects.toThrow(/in flight/);
        expect(executor.getFailureContext()).toBeUndefined();
        expect(executor.getSnapshot().runId).toBe(runId);
        release.resolve();
        expect(await pending).toEqual({ value: original });
        expect(executor.getFailureContext()).toEqual({
          category: 'server',
          stage: { runId, runtimeStageId: 'in-flight#0' },
        });
        expect(failed).toHaveLength(1);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it('a fatal closing sink failure has no native stage after otherwise healthy work', async () => {
    const executor = new FlowChartExecutor(
      flowChart('Healthy', () => {}, 'healthy')
        .setLogger(silent)
        .build(),
      {
        sink: {
          adapter: {
            ...memorySink(),
            closed() {
              throw new Error('synthetic sink loss');
            },
          },
          onFailure: 'fail',
        },
      },
    );
    await expect(executor.run()).rejects.toHaveProperty('name', 'RecordSinkError');
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
  });

  it('a native stage failure wins a subsequent fatal sink close failure', async () => {
    const original = Object.assign(new Error('synthetic stage wins sink'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Fail',
        () => {
          throw original;
        },
        'fail',
      )
        .setLogger(silent)
        .build(),
      {
        sink: {
          adapter: {
            ...memorySink(),
            closed() {
              throw new Error('synthetic secondary sink loss');
            },
          },
          onFailure: 'fail',
        },
      },
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(executor.getFailureContext()).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'fail#0' },
    });
  });

  it('a recorded pause is not sealed healthy before a fatal sink close is known', async () => {
    const executor = new FlowChartExecutor(
      flowChart(
        'Pause',
        (scope) => {
          interrupt(scope, { reason: 'synthetic recorded pause' });
        },
        'pause',
      )
        .setLogger(silent)
        .build(),
      {
        sink: {
          adapter: {
            ...memorySink(),
            closed() {
              throw new Error('synthetic paused sink loss');
            },
          },
          onFailure: 'fail',
        },
      },
    );
    await expect(executor.run()).rejects.toHaveProperty('name', 'RecordSinkError');
    expect(executor.getCheckpoint()).toBeDefined();
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
  });

  it('a checkpoint clone failure has no stage identity or borrowed pause context', async () => {
    const executor = new FlowChartExecutor(
      flowChart(
        'Pause',
        (scope) => {
          interrupt(scope, { reason: 'synthetic nonserializable question', expects: () => 'synthetic invalid shape' });
        },
        'pause',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toThrow(/pauseData/);
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
    expect(executor.getCheckpoint()).toBeUndefined();
  });

  it.each(['decider', 'selector'] as const)('a declined %s policy belongs to that native stage', async (shape) => {
    const original = Object.assign(new Error('synthetic declined stage'), { status: 503 });
    let calls = 0;
    const thrower = () => {
      calls++;
      throw original;
    };
    const seed = flowChart('Seed', () => {}, 'seed');
    const options = { retry: { attempts: 3, retryOn: () => false } };
    const branch =
      shape === 'decider'
        ? seed.addDeciderFunction('Route', thrower, 'route', undefined, options)
        : seed.addSelectorFunction('Route', thrower, 'route', undefined, options);
    const executor = new FlowChartExecutor(
      branch
        .addFunctionBranch('unused', 'Unused', () => {})
        .end()
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(calls).toBe(1);
    expect(executor.getFailureContext()).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'route#1' },
    });
  });
});

describe('native terminal failure context', () => {
  it('reports the final native stage without changing the run-boundary root or rejection', async () => {
    const original = Object.assign(new Error('synthetic terminal failure'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addFunction(
          'Failed stage',
          () => {
            throw original;
          },
          'failed-stage',
        )
        .setLogger(silent)
        .build(),
    );
    const failed: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({ id: 'terminal-context', onRunFailed: (event) => failed.push(event) });
    const rejected = await executor.run().then(
      () => ({ resolved: true }),
      (value: unknown) => ({ value }),
    );
    expect(rejected).toEqual({ value: original });
    expect(failed).toHaveLength(1);
    expect(failed[0].traversalContext?.runtimeStageId).toBe('__root__#0');
    expect(failed[0].failure).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'failed-stage#1' },
    });
    expect(executor.getFailureContext()).toEqual(failed[0].failure);
  });

  it('does not retain an earlier recovered retry when a later stage terminates', async () => {
    let attempts = 0;
    const terminal = Object.assign(new Error('synthetic terminal auth'), { status: 401 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Recover',
        () => {
          if (++attempts === 1) throw Object.assign(new Error('synthetic transient'), { status: 503 });
        },
        'recover',
      )
        .retry({ attempts: 2 })
        .addFunction(
          'Terminal',
          () => {
            throw terminal;
          },
          'terminal',
        )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(terminal);
    expect(attempts).toBe(2);
    expect(executor.getFailureContext()).toEqual({
      category: 'auth',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'terminal#1' },
    });
  });

  it('a caught call and an observed SDK failure do not populate a terminal context', async () => {
    const executor = new FlowChartExecutor(
      flowChart(
        'Handled',
        async (scope) => {
          await scope
            .$call('synthetic.lookup', () => {
              throw Object.assign(new Error('synthetic caught call'), { status: 503 });
            })
            .catch(() => undefined);
          scope.$attempt().observed({
            target: 'synthetic.sdk',
            outcome: 'failed',
            durationMs: 1,
            error: { status: 429 },
          });
        },
        'handled',
      )
        .setLogger(silent)
        .build(),
    );
    await executor.run();
    expect(executor.getFailureContext()).toBeUndefined();
  });

  it('UnknownEffectError remains unknown instead of inheriting its physical attempt category', async () => {
    const executor = new FlowChartExecutor(
      flowChart(
        'Send',
        () => {
          throw Object.assign(new Error('synthetic no answer'), { status: 503 });
        },
        'send',
      )
        .touches('synthetic-provider', { idempotencyKey: () => 'synthetic-stable-operation' })
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBeInstanceOf(UnknownEffectError);
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'send#0' },
    });
  });

  it('an escaping touching call preserves UnknownEffectError identity and never borrows its network cause category', async () => {
    const transport = Object.assign(new Error('synthetic call transport'), { code: 'ECONNRESET' });
    let wrapper: unknown;
    const executor = new FlowChartExecutor(
      flowChart(
        'Call',
        async (scope) => {
          try {
            await scope.$call(
              'synthetic.send',
              () => {
                throw transport;
              },
              undefined,
              { touches: 'synthetic-provider', idempotencyKey: 'synthetic-call-operation' },
            );
          } catch (error) {
            wrapper = error;
            throw error;
          }
        },
        'call',
      )
        .setLogger(silent)
        .build(),
    );
    let rejection: unknown;
    try {
      await executor.run();
    } catch (error) {
      rejection = error;
    }
    expect(wrapper).toBeInstanceOf(UnknownEffectError);
    expect(rejection).toBe(wrapper);
    expect((rejection as Error).cause).toBe(transport);
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'call#0' },
    });
  });

  it('a native attempt time limit retains timeout after the stage is abandoned', async () => {
    const executor = new FlowChartExecutor(
      flowChart('Timed stage', () => new Promise<void>(() => {}), 'timed')
        .retry({ attempts: 1, timeoutMs: 5 })
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toHaveProperty('name', 'AttemptTimeoutError');
    expect(executor.getFailureContext()).toEqual({
      category: 'timeout',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'timed#0' },
    });
  });

  it('a terminal transport failure uses the shared network category without a retry policy', async () => {
    const original = Object.assign(new Error('synthetic transport'), { code: 'ECONNRESET' });
    const executor = new FlowChartExecutor(
      flowChart(
        'Network',
        () => {
          throw original;
        },
        'network',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(executor.getFailureContext()).toEqual({
      category: 'network',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'network#0' },
    });
  });

  it('a commit failure names its current stage, not the earlier recovered retry', async () => {
    let attempts = 0;
    const executor = new FlowChartExecutor(
      flowChart(
        'Recover',
        () => {
          if (++attempts === 1) throw Object.assign(new Error('synthetic retry'), { status: 503 });
        },
        'recover',
      )
        .retry({ attempts: 2 })
        .addFunction(
          'Uncloneable write',
          (scope) => {
            scope.$setValue('value', () => 'synthetic');
          },
          'commit',
        )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toHaveProperty('name', 'DataCloneError');
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'commit#1' },
    });
  });

  it('a contained child failure never becomes the run terminal failure', async () => {
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction([
          {
            id: 'contained',
            name: 'Contained',
            fn: () => {
              throw new Error('synthetic contained');
            },
          },
          { id: 'healthy', name: 'Healthy', fn: () => {} },
        ])
        .setLogger(silent)
        .build(),
    );
    const failed: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({ id: 'contained-context', onRunFailed: (event) => failed.push(event) });
    await executor.run();
    expect(failed).toEqual([]);
    expect(executor.getFailureContext()).toBeUndefined();
  });

  it('global cancellation cannot borrow a contained sibling that threw the identical Error object', async () => {
    const controller = new AbortController();
    const shared = Object.assign(new Error('synthetic shared identity'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction([
          {
            id: 'contained',
            name: 'Contained',
            fn: () => {
              throw shared;
            },
          },
        ])
        .addFunction(
          'Cancel between stages',
          () => {
            controller.abort(shared);
          },
          'cancel',
        )
        .addFunction(
          'Unreached',
          () => {
            throw new Error('must remain unreached');
          },
          'unreached',
        )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run({ signal: controller.signal })).rejects.toBe(shared);
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
  });

  it('failFast selects the escaping sibling even when siblings share one Error object', async () => {
    const release = deferred();
    const settled = deferred();
    const lateObserved = deferred();
    const shared = Object.assign(new Error('synthetic shared sibling error'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction(
          [
            {
              id: 'late',
              name: 'Late',
              fn: async () => {
                await release.promise;
                settled.resolve();
                throw shared;
              },
            },
            {
              id: 'chosen',
              name: 'Chosen',
              fn: () => {
                throw shared;
              },
            },
          ],
          { failFast: true },
        )
        .setLogger(silent)
        .build(),
    );
    const errors: FlowErrorEvent[] = [];
    executor.attachFlowRecorder({
      id: 'chosen-context',
      onError: (event) => {
        errors.push(event);
        if (event.stageName === 'Late') lateObserved.resolve();
      },
    });
    try {
      await expect(executor.run()).rejects.toBe(shared);
      const expected = {
        category: 'server',
        stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'chosen#3' },
      };
      // Use the existing native event as the identity oracle; the generated fork parent consumes an index.
      const chosen = errors.find((event) => event.stageName === 'Chosen')!.traversalContext!;
      expected.stage.runtimeStageId = chosen.runtimeStageId;
      expect(executor.getFailureContext()).toEqual(expected);
      release.resolve();
      await settled.promise;
      await lateObserved.promise;
      await Promise.resolve();
      expect(executor.getFailureContext()).toEqual(expected);
    } finally {
      release.resolve();
      await settled.promise;
    }
  });

  it('an escaping failFast failure wins over a concurrently collected child pause', async () => {
    const terminal = Object.assign(new Error('synthetic failFast'), { status: 429 });
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction(
          [
            {
              id: 'pause',
              name: 'Pause',
              fn: (scope) => {
                interrupt(scope, { reason: 'synthetic approval' });
              },
            },
            {
              id: 'fail',
              name: 'Fail',
              fn: () => {
                throw terminal;
              },
            },
          ],
          { failFast: true },
        )
        .setLogger(silent)
        .build(),
    );
    const errors: FlowErrorEvent[] = [];
    executor.attachFlowRecorder({ id: 'failure-before-pause', onError: (event) => errors.push(event) });
    await expect(executor.run()).rejects.toBe(terminal);
    expect(executor.isPaused()).toBe(false);
    expect(executor.getCheckpoint()).toBeUndefined();
    expect(executor.getFailureContext()).toEqual({
      category: 'rate-limited',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: errors[0].traversalContext!.runtimeStageId },
    });
  });

  it('is absent before and during healthy work, and resets across clean runs and resume legs', async () => {
    let mode: 'fail' | 'pause' | 'healthy' = 'fail';
    const original = new Error('synthetic first run');
    const hold = deferred();
    const entered = deferred();
    const executor = new FlowChartExecutor(
      flowChart(
        'Ask',
        {
          execute: () => {
            if (mode === 'fail') throw original;
            if (mode === 'pause') return { question: 'synthetic pause' };
            return undefined;
          },
          resume: async () => {
            entered.resolve();
            await hold.promise;
          },
        },
        'ask',
      )
        .setLogger(silent)
        .build(),
    );
    expect(executor.getFailureContext()).toBeUndefined();
    await expect(executor.run()).rejects.toBe(original);
    const firstRun = executor.getFailureContext()!.stage!.runId;
    mode = 'pause';
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    expect(executor.getFailureContext()).toBeUndefined();
    const pending = executor.resume(executor.getCheckpoint()!, { approved: true });
    try {
      await entered.promise;
      expect(executor.getFailureContext()).toBeUndefined();
    } finally {
      hold.resolve();
      await pending;
    }
    expect(executor.getFailureContext()).toBeUndefined();
    mode = 'healthy';
    await executor.run();
    expect(executor.getFailureContext()).toBeUndefined();
    mode = 'fail';
    await expect(executor.run()).rejects.toBe(original);
    expect(executor.getFailureContext()!.stage!.runId).not.toBe(firstRun);
  });
});
