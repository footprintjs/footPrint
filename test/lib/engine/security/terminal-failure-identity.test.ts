import { describe, expect, it } from 'vitest';

import type { FlowAttemptEvent, FlowRunFailedEvent, TraversalContext } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

function mutateIdentity(context: TraversalContext, mutation: 'overwrite' | 'delete' | 'getters') {
  if (mutation === 'delete') {
    return Reflect.deleteProperty(context, 'runId') && Reflect.deleteProperty(context, 'runtimeStageId');
  }
  if (mutation === 'getters') {
    Object.defineProperties(context, {
      runId: { configurable: true, enumerable: true, get: () => 'forged-run' },
      runtimeStageId: { configurable: true, enumerable: true, get: () => 'forged#999' },
    });
    return true;
  }
  return Reflect.set(context, 'runId', 'forged-run') && Reflect.set(context, 'runtimeStageId', 'forged#999');
}

describe('native failure identity is independent of mutable observer context', () => {
  it.each(['overwrite', 'delete', 'getters'] as const)(
    'a policy stage keeps its native identity when onAttempt uses %s',
    async (mutation) => {
      const original = Object.assign(new Error('synthetic native owner'), { status: 503 });
      const executor = new FlowChartExecutor(
        flowChart(
          'Actual',
          () => {
            throw original;
          },
          'actual',
        )
          .retry({ attempts: 1, timeoutMs: 1000 })
          .setLogger(silent)
          .build(),
      );
      const attempts: FlowAttemptEvent[] = [];
      const terminal: FlowRunFailedEvent[] = [];
      const mutable: boolean[] = [];
      executor.attachFlowRecorder({
        id: 'mutating-attempt-context',
        onAttempt: (event) => {
          if (event.record.kind === 'stage' && event.record.next === 'stop' && event.traversalContext) {
            attempts.push(event);
            mutable.push(mutateIdentity(event.traversalContext, mutation));
          }
        },
        onRunFailed: (event) => terminal.push(event),
      });
      await expect(executor.run()).rejects.toBe(original);
      expect(mutable).toEqual([true]);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].record).toMatchObject({ kind: 'stage', category: 'server', next: 'stop' });
      expect(terminal).toHaveLength(1);
      const expected = {
        category: 'server',
        stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'actual#0' },
      };
      expect(executor.getFailureContext()).toEqual(expected);
      expect(terminal[0].failure).toEqual(expected);
    },
  );

  it.each(['call', 'observed'] as const)(
    'a no-policy stage does not borrow its identity from a contained %s event',
    async (kind) => {
      const original = Object.assign(new Error('synthetic later stage failure'), { status: 401 });
      const executor = new FlowChartExecutor(
        flowChart(
          'Actual',
          async (scope) => {
            if (kind === 'call') {
              await scope
                .$call('synthetic.contained', () => {
                  throw new Error('synthetic contained call failure');
                })
                .catch(() => undefined);
            } else {
              scope.$attempt().observed({ target: 'synthetic.sdk', outcome: 'failed', durationMs: 1 });
            }
            throw original;
          },
          'actual',
        )
          .setLogger(silent)
          .build(),
      );
      const mutable: boolean[] = [];
      executor.attachFlowRecorder({
        id: 'contained-context-mutation',
        onAttempt: (event) => {
          if (event.record.kind === kind && event.traversalContext) {
            mutable.push(mutateIdentity(event.traversalContext, 'overwrite'));
          }
        },
      });
      await expect(executor.run()).rejects.toBe(original);
      expect(mutable).toEqual([true]);
      expect(executor.getFailureContext()).toEqual({
        category: 'auth',
        stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'actual#0' },
      });
    },
  );

  it('an earlier onNext context remains mutable without becoming the next failing stage identity', async () => {
    const original = Object.assign(new Error('synthetic next stage failure'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart('Before', () => {}, 'before')
        .addFunction(
          'Actual',
          () => {
            throw original;
          },
          'actual',
        )
        .setLogger(silent)
        .build(),
    );
    const mutable: boolean[] = [];
    executor.attachFlowRecorder({
      id: 'earlier-next-context',
      onNext: (event) => {
        if (event.traversalContext) mutable.push(mutateIdentity(event.traversalContext, 'overwrite'));
      },
    });
    await expect(executor.run()).rejects.toBe(original);
    expect(mutable).toEqual([true]);
    expect(executor.getFailureContext()).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'actual#1' },
    });
  });

  it.each([false, true])(
    'a repeat commit uses the child native stamp after onFork mutation (failFast=%s)',
    async (failFast) => {
      const executor = new FlowChartExecutor(
        flowChart<Record<string, unknown>>('Seed', () => {}, 'seed')
          .addListOfFunction(
            [
              {
                id: 'broken',
                name: 'Broken child',
                fn(scope) {
                  scope.$setValue('uncloneable', () => 'synthetic child write');
                  throw new Error('synthetic superseded child failure');
                },
              },
            ],
            { failFast },
          )
          .setLogger(silent)
          .build(),
      );
      const mutable: boolean[] = [];
      executor.attachFlowRecorder({
        id: 'fork-run-context',
        onFork: (event) => {
          if (event.traversalContext) mutable.push(mutateIdentity(event.traversalContext, 'overwrite'));
        },
      });
      await expect(executor.run()).rejects.toHaveProperty('name', 'DataCloneError');
      expect(mutable).toEqual([true]);
      expect(executor.getFailureContext()).toEqual({
        category: 'unknown',
        stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'broken#1' },
      });
    },
  );

  it('onSubflowExit mutation cannot forge the mount exit clone failure identity', async () => {
    const inner = flowChart('Inner', () => {}, 'inner')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addSubFlowChartNext('mount', inner, 'Mount', {
          outputMapper: () => ({ uncloneable: () => 'synthetic exit write' }),
        })
        .setLogger(silent)
        .build(),
    );
    const mutable: boolean[] = [];
    executor.attachFlowRecorder({
      id: 'mutating-exit-context',
      onSubflowExit: (event) => {
        if (event.traversalContext) mutable.push(mutateIdentity(event.traversalContext, 'overwrite'));
      },
    });
    await expect(executor.run()).rejects.toHaveProperty('name', 'DataCloneError');
    expect(mutable).toEqual([true]);
    expect(JSON.stringify(executor.getSnapshot().executionTree)).toContain('outputMapperError');
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'mount#1' },
    });
  });

  it('a nested commit observer can mutate mount event context without changing exit failure ownership', async () => {
    const inner = flowChart(
      'Inner',
      (scope) => {
        scope.$setValue('healthy', true);
      },
      'inner',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addSubFlowChartNext('mount', inner, 'Mount', {
          outputMapper: () => ({ uncloneable: () => 'synthetic mapped write' }),
        })
        .setLogger(silent)
        .build(),
    );
    let mountContext: TraversalContext | undefined;
    const mutable: boolean[] = [];
    executor.attachFlowRecorder({
      id: 'held-mount-context',
      onSubflowEntry: (event) => {
        mountContext = event.traversalContext;
      },
    });
    executor.attachScopeRecorder({
      id: 'mutating-nested-commit',
      onCommit: () => {
        if (mountContext) mutable.push(mutateIdentity(mountContext, 'overwrite'));
      },
    });
    await expect(executor.run()).rejects.toHaveProperty('name', 'DataCloneError');
    expect(mutable.length).toBeGreaterThan(0);
    expect(mutable.every(Boolean)).toBe(true);
    expect(JSON.stringify(executor.getSnapshot().executionTree)).toContain('outputMapperError');
    expect(executor.getFailureContext()).toEqual({
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'mount#1' },
    });
  });
});
