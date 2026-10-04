import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, MetricRecorder } from '../../../../src/index';

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('metrics during parallel traversal', () => {
  it.each(['inline', 'deferred'] as const)('credits overlapping branches with %s delivery', async (delivery) => {
    const bStarted = gate();
    const aWrote = gate();
    const order: string[] = [];
    const chart = flowChart<{ seed: number; first?: number; second?: number }>(
      'Seed',
      (scope) => {
        scope.seed = 5;
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'a',
          name: 'A',
          fn: async (scope) => {
            order.push('A:start');
            await bStarted.promise;
            scope.first = scope.seed;
            scope.second = 2;
            order.push('A:wrote');
            aWrote.release();
          },
        },
        {
          id: 'b',
          name: 'B',
          fn: async (scope) => {
            order.push('B:start');
            bStarted.release();
            await aWrote.promise;
            scope.first = scope.seed;
            order.push('B:wrote');
          },
        },
      ])
      .build();
    const recorder = new MetricRecorder('parallel-metrics');
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(recorder, { delivery });

    await executor.run();

    expect(order).toEqual(['A:start', 'B:start', 'A:wrote', 'B:wrote']);
    expect(recorder.getByKey('a#1')).toMatchObject({ stageName: 'A', readCount: 1, writeCount: 2, commitCount: 2 });
    expect(recorder.getByKey('b#2')).toMatchObject({ stageName: 'B', readCount: 1, writeCount: 1, commitCount: 2 });
    expect(recorder.getByKey('seed#0')).toMatchObject({
      stageName: 'Seed',
      readCount: 0,
      writeCount: 1,
      commitCount: 1,
    });
    expect(recorder.getStageMetrics('A')).toMatchObject({ invocationCount: 1, writeCount: 2, commitCount: 2 });
    expect(recorder.getMetrics()).toMatchObject({ totalReads: 2, totalWrites: 4, totalCommits: 5 });
    expect(recorder.accumulate((sum, step) => sum + step.writeCount, 0, new Set(['a#1']))).toBe(2);
  });
});
