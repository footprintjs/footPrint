import { buildAttemptId } from 'foottrace';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

/** Enable the private producer seam; the public closed-capture option is exercised by its own tests. */
function observeNativeSelection(enabled = true) {
  const frames: StageContext[] = [];
  const bind = StageContext.prototype.bindFailureIdentity;
  vi.spyOn(StageContext.prototype, 'bindFailureIdentity').mockImplementation(function (
    this: StageContext,
    runId,
    runtimeStageId,
  ) {
    bind.call(this, runId, runtimeStageId);
    if (enabled) this.captureClosureTracking = true;
    frames.push(this);
  });
  return () => [...new Set(frames.map((frame) => frame.failureState))].flatMap((state) => state.selected ?? []);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the native escaping invocation is selected during execution', () => {
  it.each(['sync', 'promise'] as const)('selects a direct %s failure without a retry record', async (mode) => {
    const selection = observeNativeSelection();
    const original = Object.assign(new Error('private original'), { status: 503 });
    let calls = 0;
    const executor = new FlowChartExecutor(
      flowChart(
        'Failure',
        () => {
          calls++;
          if (mode === 'promise') return Promise.reject(original);
          throw original;
        },
        'failure',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(calls).toBe(1);
    const runId = executor.getSnapshot().runId;
    expect(selection()).toEqual([
      { kind: 'invocation', runId, runtimeStageId: 'failure#0', attemptId: buildAttemptId('failure#0', 1) },
    ]);
    expect(executor.getFailureContext()).toEqual({ category: 'server', stage: { runId, runtimeStageId: 'failure#0' } });
    expect(JSON.stringify(selection())).not.toContain(original.message);
  });

  it('selects the second actual native retry, not its first failed invocation', async () => {
    const selection = observeNativeSelection();
    const original = Object.assign(new Error('private retry'), { status: 503 });
    let calls = 0;
    const executor = new FlowChartExecutor(
      flowChart(
        'Failure',
        () => {
          calls++;
          throw original;
        },
        'failure',
      )
        .retry({ attempts: 2 })
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(calls).toBe(2);
    expect(selection()).toEqual([
      {
        kind: 'invocation',
        runId: executor.getSnapshot().runId,
        runtimeStageId: 'failure#0',
        attemptId: buildAttemptId('failure#0', 2),
      },
    ]);
  });

  it('does not retain an earlier recovered invocation when the next execution fails', async () => {
    const selection = observeNativeSelection();
    const original = new Error('private final failure');
    let recovered = 0;
    const executor = new FlowChartExecutor(
      flowChart(
        'Recover',
        () => {
          if (++recovered === 1) throw new Error('private recovered');
        },
        'recover',
      )
        .retry({ attempts: 2 })
        .addFunction(
          'Final',
          () => {
            throw original;
          },
          'final',
        )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(selection()).toEqual([
      {
        kind: 'invocation',
        runId: executor.getSnapshot().runId,
        runtimeStageId: 'final#1',
        attemptId: buildAttemptId('final#1', 1),
      },
    ]);
  });

  it('a commit failure never borrows the invocation that staged the uncloneable value', async () => {
    const selection = observeNativeSelection();
    const executor = new FlowChartExecutor(
      flowChart<{ value?: unknown }>(
        'Uncloneable',
        (scope) => {
          scope.value = () => undefined;
        },
        'uncloneable',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toHaveProperty('name', 'DataCloneError');
    expect(selection()).toEqual([
      { kind: 'commit', runId: executor.getSnapshot().runId, runtimeStageId: 'uncloneable#0' },
    ]);
  });

  it('a same-object commit replacement is still labelled as a commit', async () => {
    const selection = observeNativeSelection();
    const original = new Error('private reused error');
    const commit = StageContext.prototype.commit;
    vi.spyOn(StageContext.prototype, 'commit').mockImplementation(function (this: StageContext, ...args) {
      if (this.stageId === 'failure') throw original;
      return commit.apply(this, args);
    });
    const executor = new FlowChartExecutor(
      flowChart(
        'Failure',
        () => {
          throw original;
        },
        'failure',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(selection()).toEqual([{ kind: 'commit', runId: executor.getSnapshot().runId, runtimeStageId: 'failure#0' }]);
  });

  it('contained call errors and mutable attempt events do not replace the native invocation', async () => {
    const selection = observeNativeSelection();
    const original = Object.assign(new Error('private outer failure'), { status: 401 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Failure',
        async (scope) => {
          await scope
            .$call('local.lookup', () => {
              throw new Error('private handled call');
            })
            .catch(() => undefined);
          throw original;
        },
        'failure',
      )
        .retry({ attempts: 1, timeoutMs: 1000 })
        .setLogger(silent)
        .build(),
    );
    executor.attachFlowRecorder({
      id: 'mutating-event',
      onAttempt: (event) => {
        if (event.traversalContext) Reflect.set(event.traversalContext, 'runtimeStageId', 'forged#99');
      },
    });
    await expect(executor.run()).rejects.toBe(original);
    expect(selection()).toEqual([
      {
        kind: 'invocation',
        runId: executor.getSnapshot().runId,
        runtimeStageId: 'failure#0',
        attemptId: buildAttemptId('failure#0', 1),
      },
    ]);
  });

  it('a timed-out native wait does not claim that its still-pending function threw', async () => {
    vi.useFakeTimers();
    const selection = observeNativeSelection();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new FlowChartExecutor(
      flowChart('Pending', () => pending, 'pending')
        .retry({ attempts: 1, timeoutMs: 100 })
        .setLogger(silent)
        .build(),
    );
    const result = executor.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toHaveProperty('name', 'AttemptTimeoutError');
    expect(selection()).toEqual([]);
    release();
    await pending;
    expect(selection()).toEqual([]);
  });

  it('with the option off the old context has no stronger selected witness', async () => {
    const selection = observeNativeSelection(false);
    const original = new Error('private off-path failure');
    const executor = new FlowChartExecutor(
      flowChart(
        'Failure',
        () => {
          throw original;
        },
        'failure',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(selection()).toEqual([]);
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'failure#0' },
    });
  });

  it('a later preparation failure cannot borrow a recovered invocation throwing the same object', async () => {
    const selection = observeNativeSelection();
    const original = new Error('private preparation replacement');
    let preparations = 0;
    let calls = 0;
    const executor = new FlowChartExecutor(
      flowChart<void, ScopeFacade>(
        'Failure',
        () => {
          calls++;
          throw original;
        },
        'failure',
      )
        .retry({ attempts: 2 })
        .setLogger(silent)
        .build(),
      {
        scopeFactory(context, name, input, env) {
          if (++preparations === 2) throw original;
          return new ScopeFacade(context, name, input, env);
        },
      },
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(preparations).toBe(2);
    expect(calls).toBe(1);
    expect(selection()).toEqual([]);
  });

  it('a pause is never selected as a failed invocation', async () => {
    const selection = observeNativeSelection();
    const executor = new FlowChartExecutor(
      flowChart('Pause', (scope) => interrupt(scope, { reason: 'local approval' }), 'pause')
        .setLogger(silent)
        .build(),
    );
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    expect(executor.getFailureContext()).toBeUndefined();
    expect(selection()).toEqual([]);
  });

  it('a contained parallel failure grants no terminal selection', async () => {
    const selection = observeNativeSelection();
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction([
          {
            id: 'contained',
            name: 'Contained',
            fn: () => {
              throw new Error('private contained');
            },
          },
          { id: 'healthy', name: 'Healthy', fn: () => {} },
        ])
        .setLogger(silent)
        .build(),
    );
    await executor.run();
    expect(executor.getFailureContext()).toBeUndefined();
    expect(selection()).toEqual([]);
  });
});
