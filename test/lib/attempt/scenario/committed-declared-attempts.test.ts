import type { RecordSink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { declaredFailures } from '../../../../src/declared-attempts.js';
import type { FlowAttemptEvent, FlowRecorder, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';

interface State {
  settled?: { call: string }[];
  single?: { call: string };
  unrelated?: unknown;
}

const timing = { category: 'timeout', startedAt: 1700000000000, durationMs: 15 } as const;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

function probe() {
  const order: string[] = [];
  const records: FlowAttemptEvent['record'][] = [];
  const sink: RecordSink = {
    opened() {},
    commit() {
      order.push('commit');
    },
    note() {},
    closed() {},
  };
  const recorder: FlowRecorder = {
    id: 'committed-attempts',
    onAttempt: ({ record }) => {
      records.push(record);
      if (record.provenance === 'declared') order.push('declared');
      else if (record.kind === 'observed') order.push('sdk');
    },
  };
  return {
    order,
    records,
    sink,
    recorder,
    declared: () => records.filter((record) => record.provenance === 'declared'),
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe.each(['full', 'delta'] as const)('committed declared attempts (%s)', (commitValues) => {
  it.each(['direct', 'retry-managed'] as const)(
    'reports two dispatches from one landed settlement write in a %s stage',
    async (mode) => {
      const builder = flowChart<State>(
        'Settle',
        (scope) => {
          const attempt = scope.$attempt();
          const failures = declaredFailures(scope);
          const first = failures.begin('lookup');
          const second = failures.begin('lookup');
          attempt.observed({ target: 'sdk.lookup', outcome: 'ok', durationMs: 6 });
          failures.setValue(
            'settled',
            [{ call: 'first' }, { call: 'second' }],
            [
              { dispatch: first, at: ['0'], ...timing },
              { dispatch: second, at: ['1'], ...timing, durationMs: 24 },
            ],
          );
          scope.unrelated = true;
        },
        'settle',
      );
      if (mode === 'retry-managed') builder.retry({ attempts: 2 });

      const p = probe();
      const executor = new FlowChartExecutor(builder.build(), { commitValues, sink: p.sink });
      executor.attachFlowRecorder(p.recorder);
      await executor.run();

      expect(p.order).toEqual(['sdk', 'commit', 'declared', 'declared']);
      expect(p.records.find((record) => record.target === 'sdk.lookup')).toMatchObject({
        kind: 'observed',
        outcome: 'ok',
        source: 'sdk',
        durationMs: 6,
      });
      expect(p.declared()).toMatchObject([
        { kind: 'observed', target: 'lookup', outcome: 'failed', provenance: 'declared', ...timing },
        { kind: 'observed', target: 'lookup', outcome: 'failed', provenance: 'declared', ...timing, durationMs: 24 },
      ]);
      expect(new Set(p.declared().map(({ series }) => series)).size).toBe(2);
      expect(executor.getSnapshot().sharedState.settled).toEqual([{ call: 'first' }, { call: 'second' }]);
      expect(executor.getSnapshot().executionTree.attempts).toEqual(expect.arrayContaining(p.declared()));
    },
  );

  it.each(['direct', 'retry-managed'] as const)(
    'withholds a settlement when a %s stage cannot commit',
    async (mode) => {
      const builder = flowChart<State>(
        'Fail commit',
        (scope) => {
          const failures = declaredFailures(scope);
          const dispatch = failures.begin('lookup');
          failures.setValue('single', { call: 'first' }, [{ dispatch, at: [], ...timing }]);
          scope.unrelated = () => 'uncloneable';
        },
        'fail-commit',
      );
      if (mode === 'retry-managed') builder.retry({ attempts: 2 });

      const p = probe();
      const executor = new FlowChartExecutor(builder.build(), { commitValues, logger: silent, sink: p.sink });
      executor.attachFlowRecorder(p.recorder);
      await expect(executor.run()).rejects.toThrow();

      expect(p.order).toEqual([]);
      expect(executor.getSnapshot().commitLog).toEqual([]);
      expect(executor.getSnapshot().sharedState).not.toHaveProperty('single');
      const stageRecords = p.records.filter(({ kind }) => kind === 'stage');
      expect(stageRecords).toMatchObject(mode === 'direct' ? [] : [{ attempt: 1, outcome: 'ok' }]);
    },
  );

  it.each(['replace', 'nested replace', 'delete'] as const)(
    'withholds a declaration when a later write performs %s on its settlement',
    async (change) => {
      const chart = flowChart<State>(
        'Supersede settlement',
        (scope) => {
          const failures = declaredFailures(scope);
          const dispatch = failures.begin('lookup');
          failures.setValue('settled', [{ call: 'original' }], [{ dispatch, at: ['0'], ...timing }]);
          if (change === 'replace') scope.settled = [{ call: 'replacement' }];
          if (change === 'nested replace') scope.settled![0].call = 'replacement';
          if (change === 'delete') scope.$delete('settled');
        },
        'supersede',
      ).build();
      const p = probe();
      const executor = new FlowChartExecutor(chart, { commitValues, sink: p.sink });
      executor.attachFlowRecorder(p.recorder);
      await executor.run();

      expect(p.order).toEqual(['commit']);
      expect(executor.getSnapshot().sharedState.settled).toEqual(
        change === 'delete' ? undefined : [{ call: 'replacement' }],
      );
    },
  );

  it.each(['no change', 'borrowed edit'] as const)('withholds a settlement with %s', async (change) => {
    const entry = { call: 'original' };
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.single = { ...entry };
      },
      'seed',
    )
      .addFunction(
        'Settle',
        (scope) => {
          const failures = declaredFailures(scope);
          const dispatch = failures.begin('lookup');
          const value = { call: change === 'no change' ? 'original' : 'new' };
          failures.setValue('single', value, [{ dispatch, at: [], ...timing }]);
          if (change === 'borrowed edit') value.call = 'changed outside the write funnel';
        },
        'settle',
      )
      .build();
    const p = probe();
    const executor = new FlowChartExecutor(chart, { commitValues, sink: p.sink });
    executor.attachFlowRecorder(p.recorder);
    await executor.run();

    expect(p.order).toEqual(['commit', 'commit']);
  });

  it.each(['pause', 'error'] as const)(
    'reports a settled sibling when a subsequent dispatch ends the stage with a %s',
    async (terminal) => {
      const problem = new Error('second dispatch failed');
      const chart = flowChart<State>(
        'Settle then stop',
        (scope) => {
          const failures = declaredFailures(scope);
          const first = failures.begin('first.lookup');
          failures.setValue('settled', [{ call: 'first' }], [{ dispatch: first, at: ['0'], ...timing }]);
          failures.begin('second.lookup');
          if (terminal === 'pause') interrupt(scope, { question: 'Continue?' });
          throw problem;
        },
        'settle-then-stop',
      ).build();
      const p = probe();
      const executor = new FlowChartExecutor(chart, { commitValues, logger: silent, sink: p.sink });
      executor.attachFlowRecorder(p.recorder);
      if (terminal === 'pause') await expect(executor.run()).resolves.toMatchObject({ paused: true });
      else await expect(executor.run()).rejects.toBe(problem);

      expect(p.order).toEqual(['commit', 'declared']);
      expect(p.declared()).toMatchObject([{ target: 'first.lookup', ...timing }]);
      expect(executor.getSnapshot().sharedState.settled).toEqual([{ call: 'first' }]);
    },
  );
});

it('keeps SDK observations while discarding failed stage staging and fencing retained handles', async () => {
  let armOld!: (scope: TypedScope<State>) => void;
  const chart = flowChart<State>(
    'Retry',
    (scope) => {
      const attempt = scope.$attempt();
      const failures = declaredFailures(scope);
      if (attempt.attempt === 1) {
        const discarded = failures.begin('discarded.lookup');
        failures.setValue('single', { call: 'discarded' }, [{ dispatch: discarded, at: [], ...timing }]);
        const unsettled = failures.begin('unsettled.lookup');
        armOld = (liveScope) => {
          declaredFailures(liveScope).setValue('single', { call: 'unsettled' }, [
            { dispatch: unsettled, at: [], ...timing },
          ]);
        };
        attempt.observed({ target: 'sdk.lookup', outcome: 'ok', durationMs: 6 });
        throw new Error('retry the stage');
      }
      expect(() => armOld(scope)).toThrow();
      const dispatch = failures.begin('retry.lookup');
      failures.setValue('single', { call: 'second' }, [{ dispatch, at: [], ...timing }]);
    },
    'retry',
  )
    .retry({ attempts: 2 })
    .build();
  const p = probe();
  const executor = new FlowChartExecutor(chart, { sink: p.sink });
  executor.attachFlowRecorder(p.recorder);
  await executor.run();

  expect(p.order).toEqual(['sdk', 'commit', 'declared']);
  expect(p.declared()).toMatchObject([{ target: 'retry.lookup', ...timing }]);
  expect(p.records.filter(({ kind }) => kind === 'stage').map(({ outcome }) => outcome)).toEqual(['failed', 'ok']);
  expect(executor.getSnapshot().sharedState.single).toEqual({ call: 'second' });
});

it('rejects duplicate and foreign handles without replacing a valid staged settlement', async () => {
  let armForeign!: (scope: TypedScope<State>) => void;
  const chart = flowChart<State>(
    'Settle',
    (scope) => {
      const failures = declaredFailures(scope);
      const dispatch = failures.begin('lookup');
      expect(() =>
        failures.setValue(
          'settled',
          [{ call: 'one' }, { call: 'duplicate' }],
          [
            { dispatch, at: ['0'], ...timing },
            { dispatch, at: ['1'], ...timing },
          ],
        ),
      ).toThrow();
      expect(scope.settled).toBeUndefined();
      failures.setValue('single', { call: 'valid' }, [{ dispatch, at: [], ...timing }]);
      expect(() => failures.setValue('single', { call: 'duplicate' }, [{ dispatch, at: [], ...timing }])).toThrow();

      const unused = failures.begin('unused.lookup');
      armForeign = (otherScope) => {
        declaredFailures(otherScope).setValue('single', { call: 'foreign' }, [{ dispatch: unused, at: [], ...timing }]);
      };
    },
    'settle',
  )
    .addFunction(
      'Next stage',
      (scope) => {
        expect(() => armForeign(scope)).toThrow();
      },
      'next',
    )
    .build();
  const p = probe();
  const executor = new FlowChartExecutor(chart, { sink: p.sink });
  executor.attachFlowRecorder(p.recorder);
  await executor.run();

  expect(p.order).toEqual(['commit', 'declared', 'commit']);
  expect(p.declared()).toMatchObject([{ target: 'lookup', ...timing }]);
  expect(executor.getSnapshot().sharedState.single).toEqual({ call: 'valid' });
});

it.each(['direct', 'retry-managed'] as const)(
  'does not arm a late completion after cancellation in a %s stage',
  async (mode) => {
    const caller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const completed = deferred();
    let lateError: unknown;
    const builder = flowChart<State>(
      'Cancel',
      async (scope) => {
        const failures = declaredFailures(scope);
        const dispatch = failures.begin('late.lookup');
        entered.resolve();
        await release.promise;
        try {
          failures.setValue('single', { call: 'late' }, [{ dispatch, at: [], ...timing }]);
        } catch (error) {
          lateError = error;
        } finally {
          completed.resolve();
        }
      },
      'cancel',
    );
    if (mode === 'retry-managed') builder.retry({ attempts: 2 });

    const p = probe();
    const executor = new FlowChartExecutor(builder.build(), { logger: silent, sink: p.sink });
    executor.attachFlowRecorder(p.recorder);
    const outcome = executor.run({ signal: caller.signal });
    await Promise.race([entered.promise, outcome]);
    caller.abort(new Error('caller stopped'));
    try {
      await expect(outcome).rejects.toThrow('caller stopped');
    } finally {
      release.resolve();
    }
    await completed.promise;

    expect(lateError).toBeInstanceOf(Error);
    expect(p.declared()).toEqual([]);
    expect(executor.getSnapshot().sharedState).not.toHaveProperty('single');
  },
);
