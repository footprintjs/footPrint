/**
 * Ids made at RUN time obey the same grammar as ids made at build (F7, 9.37.0).
 *
 * 1. A nested subflow inside a LAZY mount or a `parallelForEach` branch is
 *    prefixed under its mount, as the builder's `_mergeSubflows` does for an
 *    eager mount. Before 9.37.0 its root was stored unprefixed: a lazy mount ran
 *    `sf-x/leaf#4` (depth 1) where the eager mount ran `lz/sf-x/leaf#4`
 *    (depth 2), and every `parallelForEach` branch ran its inner stage under the
 *    SAME id `sf-x/leaf`.
 * 2. A stage that RETURNS a StageNode adopts ids the builder never saw; R5
 *    refuses `#` and `/` there too, on the stage's error path.
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';

type S = Record<string, any>;
const set = (k: string) => (s: S) => {
  s[k] = (s[k] ?? 0) + 1;
};
const leaf = () => flowChart('Leaf', set('leaf'), 'leaf').build();
const withSub = () => flowChart('E', set('e'), 'e').addSubFlowChartNext('sf-x', leaf(), 'X').build();

async function stamps(chart: FlowChart) {
  const seen: Array<{ rid: string; depth: number }> = [];
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder({
    id: 'ids',
    onStageExecuted: (e) => {
      seen.push({ rid: e.traversalContext!.runtimeStageId, depth: e.traversalContext!.depth });
    },
  });
  await executor.run();
  return { seen, executor };
}

describe('nested subflows under run-time mounts are prefixed like eager ones', () => {
  it('a lazy mount and an eager mount give the same ids and depths', async () => {
    const lazy = await stamps(flowChart('Init', set('i'), 'init').addLazySubFlowChartNext('lz', withSub, 'L').build());
    const eager = await stamps(flowChart('Init', set('i'), 'init').addSubFlowChartNext('lz', withSub(), 'E').build());
    expect(lazy.seen).toEqual(eager.seen);
    expect(lazy.seen.map((s) => s.rid)).toContain('lz/sf-x/leaf#4');
    // subflowResults are keyed by the prefixed path on both.
    expect(Object.keys(lazy.executor.getSnapshot().subflowResults ?? {})).toEqual(
      expect.arrayContaining(['lz', 'lz/sf-x']),
    );
  });

  it('parallelForEach branches run their nested subflow under DISTINCT ids, deeper than the mount', async () => {
    const { seen, executor } = await stamps(
      flowChart('Init', set('i'), 'init')
        .addParallelForEach('Each', 'each', {
          items: () => ['a', 'b'],
          branch: () => withSub(),
          maxBranches: 2,
          into: 'r',
        })
        .build(),
    );
    const leaves = seen.filter((s) => s.rid.includes('/leaf#')).map((s) => s.rid.split('#')[0]);
    expect(leaves.sort()).toEqual(['each~0/sf-x/leaf', 'each~1/sf-x/leaf']);
    for (const s of seen.filter((x) => x.rid.includes('/leaf#'))) expect(s.depth).toBe(2);
    expect(Object.keys(executor.getSnapshot().subflowResults ?? {})).toEqual(
      expect.arrayContaining(['each~0/sf-x', 'each~1/sf-x']),
    );
  });

  it('depth is monotonic: a mount sits above what runs inside it', async () => {
    const { seen } = await stamps(
      flowChart('Init', set('i'), 'init').addLazySubFlowChartNext('lz', withSub, 'L').build(),
    );
    const depthOf = (prefix: string) => seen.find((s) => s.rid.startsWith(prefix))!.depth;
    expect(depthOf('lz#')).toBeLessThan(depthOf('lz/e#'));
    expect(depthOf('lz/sf-x#')).toBeLessThan(depthOf('lz/sf-x/leaf#'));
  });
});

describe('R5 at the run-time door — a returned StageNode', () => {
  const dynamicChart = (id: string) =>
    flowChart('Init', () => ({ name: 'Dyn', id: 'dyn-parent', next: { name: 'DynN', id, fn: set('dyn') } }), 'init')
      .addFunction('After', set('after'), 'after')
      .build();

  for (const delimiter of ['#', '/']) {
    it(`refuses an adopted id containing '${delimiter}', on the stage's error path`, async () => {
      const errors: string[] = [];
      const executor = new FlowChartExecutor(dynamicChart(`dyn${delimiter}x`));
      executor.attachFlowRecorder({
        id: 'errors',
        onError: (e) => {
          errors.push(e.message);
        },
      });
      await expect(executor.run()).rejects.toThrow(
        new RegExp(
          `dynamic StageNode: dynamic stage id 'dyn${delimiter}x' contains the reserved character '${delimiter}'`,
        ),
      );
      expect(errors).toHaveLength(1);
      // The stage's own writes still committed (the error path commits), and nothing adopted ran.
      expect(executor.getSnapshot().commitLog.map((b) => b.runtimeStageId)).toEqual(['init#0']);
    });
  }

  it('admits a plain adopted id', async () => {
    const executor = new FlowChartExecutor(dynamicChart('dyn-x'));
    await executor.run();
    expect(executor.getSnapshot().commitLog.map((b) => b.runtimeStageId)).toEqual(['init#0', 'dyn-x#1']);
  });
});
