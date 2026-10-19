import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowErrorEvent, FlowRunFailedEvent, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

afterEach(() => vi.restoreAllMocks());

describe.each(['linear', 'decider', 'selector'] as const)('failed %s commits keep native ownership', (shape) => {
  it.each(['throw', 'pause'] as const)(
    'a clone failure while handling %s keeps its own exact error and stage',
    async (ending) => {
      const business = Object.assign(new Error('synthetic superseded business failure'), { status: 503 });
      const body = (scope: TypedScope<Record<string, unknown>>) => {
        scope.$setValue('uncloneable', () => 'synthetic uncloneable write');
        if (ending === 'pause') {
          interrupt(scope, { reason: 'synthetic pause before commit' });
          return;
        }
        throw business;
      };
      const seed = flowChart<Record<string, unknown>>('Seed', () => {}, 'seed');
      const chart =
        shape === 'linear'
          ? flowChart<Record<string, unknown>>('Broken', body, 'broken').setLogger(silent).build()
          : (shape === 'decider'
              ? seed.addDeciderFunction('Broken', body, 'broken')
              : seed.addSelectorFunction('Broken', body, 'broken')
            )
              .addFunctionBranch('unused', 'Unused', () => {})
              .end()
              .setLogger(silent)
              .build();
      const commit = StageContext.prototype.commit;
      let cloneFailure: unknown;
      vi.spyOn(StageContext.prototype, 'commit').mockImplementation(function (this: StageContext, ...args) {
        try {
          return commit.apply(this, args);
        } catch (error) {
          cloneFailure = error;
          throw error;
        }
      });
      const executor = new FlowChartExecutor(chart);
      const stageErrors: FlowErrorEvent[] = [];
      const terminal: FlowRunFailedEvent[] = [];
      const pauses: unknown[] = [];
      executor.attachFlowRecorder({
        id: 'failed-commit-context',
        onError: (event) => stageErrors.push(event),
        onPause: (event) => pauses.push(event),
        onRunFailed: (event) => terminal.push(event),
      });
      let escaped: unknown;
      try {
        await executor.run();
      } catch (error) {
        escaped = error;
      }
      expect(escaped).toHaveProperty('name', 'DataCloneError');
      expect(escaped).toBe(cloneFailure);
      expect(escaped).not.toBe(business);
      const snapshot = executor.getSnapshot();
      const failed = shape === 'linear' ? snapshot.executionTree : snapshot.executionTree.next;
      // Preserve the old direct-commit path: no new diagnostics, attempt rows, pause event or failed bundle.
      expect(stageErrors).toEqual([]);
      expect(pauses).toEqual([]);
      expect(failed?.errors).toEqual({});
      expect(failed?.attention).toBeUndefined();
      expect(failed?.attempts).toBeUndefined();
      expect(snapshot.commitLog.filter((bundle) => bundle.stageId === 'broken')).toEqual([]);
      expect(terminal).toHaveLength(1);
      const expected = {
        category: 'unknown',
        stage: { runId: snapshot.runId, runtimeStageId: shape === 'linear' ? 'broken#0' : 'broken#1' },
      };
      expect(executor.getFailureContext()).toEqual(expected);
      expect(terminal[0].failure).toEqual(expected);
      expect(executor.isPaused()).toBe(false);
    },
  );
});

it('classifies a no-policy thrown error before an onCommit observer can mutate its raw status', async () => {
  const original = Object.assign(new Error('synthetic commit-listener mutation'), { status: 503 });
  const executor = new FlowChartExecutor(
    flowChart(
      'Failure',
      (scope) => {
        scope.$setValue('committed', true);
        throw original;
      },
      'failure',
    )
      .setLogger(silent)
      .build(),
  );
  let commits = 0;
  executor.attachScopeRecorder({
    id: 'mutating-commit-listener',
    onCommit: () => {
      commits++;
      original.status = 401;
    },
  });
  await expect(executor.run()).rejects.toBe(original);
  expect(commits).toBe(1);
  expect(original.status).toBe(401);
  expect(executor.getFailureContext()).toEqual({
    category: 'server',
    stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'failure#0' },
  });
});
