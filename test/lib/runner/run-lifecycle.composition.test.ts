import { describe, expect, it } from 'vitest';

import type { RunLifecycle, RunSlot } from '../../../src';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src';

describe('run lifecycle mounted children', () => {
  it('isolates repeated mounts, two parents and a simultaneous direct child admission', async () => {
    const seen: Array<{ runId: string; cell: { count: number; label: string }; shared: { labels: string[] } }> = [];
    const child = flowChart<{ done?: boolean }>(
      'child',
      async (scope) => {
        const bound = owner.forScope(scope);
        const cell = bound.local(runtime, () => ({ count: 0, label: scope.$getArgs<{ label: string }>().label }));
        const shared = bound.local(leg, () => ({ labels: [] as string[] }));
        cell.count += 1;
        shared.labels.push(cell.label);
        seen.push({ runId: bound.origin.runId, cell, shared });
        await Promise.resolve();
        scope.done = true;
      },
      'child',
    ).build();
    const owner: RunLifecycle = createRunLifecycle(child, { runnerId: 'shared-child' });
    const runtime: RunSlot<{ count: number; label: string }> = owner.slot('runtime');
    const leg: RunSlot<{ labels: string[] }> = owner.slot('leg');
    const parent = flowChart<{ prefix?: string }>(
      'seed',
      async (scope) => {
        scope.prefix = scope.$getArgs<{ label: string }>().label;
      },
      'seed',
    )
      .addSubFlowChartNext('one', child, 'one', { inputMapper: (scope) => ({ label: `${scope.prefix}-one` }) })
      .addSubFlowChartNext('two', child, 'two', { inputMapper: (scope) => ({ label: `${scope.prefix}-two` }) })
      .build();
    const a = new FlowChartExecutor(parent);
    const b = new FlowChartExecutor(parent);
    let directId = '';
    await Promise.all([
      a.run({ input: { label: 'A' } }),
      b.run({ input: { label: 'B' } }),
      owner.withRun(async (run) => {
        run.set(runtime, { count: 0, label: 'direct' });
        await run.execute({ kind: 'run' });
        directId = run.origin!.runId;
      }),
    ]);
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((row) => row.cell)).size).toBe(5);
    expect(new Set(seen.map((row) => row.shared)).size).toBe(3);
    expect(seen.map((row) => row.cell.count)).toEqual([1, 1, 1, 1, 1]);
    expect(seen.map((row) => row.cell.label).sort()).toEqual(['A-one', 'A-two', 'B-one', 'B-two', 'direct']);
    for (const executor of [a, b]) {
      const rows = seen.filter((row) => row.runId === executor.getSnapshot().runId);
      expect(rows).toHaveLength(2);
      expect(rows[0].shared).toBe(rows[1].shared);
    }
    expect(owner.view()!.origin!.runId).toBe(directId);
    expect(owner.view()!.snapshot()!.sharedState.done).toBe(true);
  });
});
