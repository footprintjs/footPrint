/**
 * The execution tree is a list (12.0.0): the run's stages in the order they ran, a fork's children
 * as `branches`. Its depth is how far forks nest, never how long the run was, so a snapshot of any
 * length can be copied (`structuredClone`) and saved (`JSON.stringify`). Before, each stage held the
 * next in `next`: copying failed near 3,000 stages and saving near 10,000.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { StageSnapshot } from '../../../../src/lib/memory/frameTypes.js';
import { stagesOf } from '../../../helpers/executionTree.js';

/** The deepest nesting of plain objects and arrays in a value, walked with a loop. */
function depthOf(value: unknown): number {
  let deepest = 0;
  const work: Array<[unknown, number]> = [[value, 1]];
  while (work.length > 0) {
    const [item, depth] = work.pop()!;
    if (!item || typeof item !== 'object') continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(item)) work.push([child, depth + 1]);
  }
  return deepest;
}

async function loopRun(passes: number) {
  const chart = flowChart(
    'Start',
    (scope: any) => {
      scope.i = 0;
    },
    'start',
  )
    .addFunction(
      'Step',
      (scope: any) => {
        scope.i += 1;
        if (scope.i >= passes) scope.$break();
      },
      'step',
    )
    .loopTo('step')
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run({ maxIterations: passes + 10 });
  return executor.getSnapshot();
}

describe('the execution tree is a list of stages', () => {
  it('holds every stage of a loop in run order, one item each', async () => {
    const tree = (await loopRun(5)).executionTree as StageSnapshot[];
    expect(tree.map((stage) => stage.id)).toEqual(['start', 'step', 'step', 'step', 'step', 'step']);
    expect(tree.map((stage) => stage.runtimeStageId)).toEqual([
      'start#0',
      'step#1',
      'step#2',
      'step#3',
      'step#4',
      'step#5',
    ]);
    expect(tree.some((stage) => Object.hasOwn(stage, 'next') || Object.hasOwn(stage, 'children'))).toBe(false);
  });

  it('copies and saves a 30,000-stage run', async () => {
    const snapshot = await loopRun(30_000);
    expect((snapshot.executionTree as StageSnapshot[]).length).toBe(30_001);
    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  }, 60_000);

  it('is as deep for a long run as for a short one', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 400 }), async (passes) => {
        const tree = (await loopRun(passes)).executionTree;
        expect(depthOf(tree)).toBe(depthOf((await loopRun(1)).executionTree));
      }),
      { numRuns: 15 },
    );
  });

  it("puts a fork's children in branches, and the stage after the fork next in the same list", async () => {
    const chart = flowChart('Seed', () => {}, 'seed')
      .addListOfFunction([
        { id: 'left', name: 'Left', fn: () => {} },
        { id: 'right', name: 'Right', fn: () => {} },
      ])
      .addFunction('Join', () => {}, 'join')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const tree = executor.getSnapshot().executionTree as StageSnapshot[];
    expect(tree.map((stage) => stage.id)).toEqual(['seed', 'join']);
    expect(tree[0].branches?.map((branch) => branch.map((stage) => stage.runtimeStageId))).toEqual([
      ['left#1'],
      ['right#2'],
    ]);
    expect(stagesOf(tree).map((stage) => stage.id)).toEqual(['seed', 'left', 'right', 'join']);
  });
});
