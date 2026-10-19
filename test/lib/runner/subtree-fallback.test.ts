import { afterEach, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../src/index.js';

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

it('drills into a tree-only subflow and explicitly leaves unavailable state absent', async () => {
  const child = flowChart<{ answer: number }>(
    'Child',
    (scope) => {
      scope.answer = 42;
    },
    'child',
  ).build();
  const chart = flowChart('Seed', () => {}, 'seed')
    .addSubFlowChartNext('mount', child, 'Mounted child')
    .addFunction('After', () => {}, 'after')
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  const snapshot = { ...executor.getSnapshot(), subflowResults: undefined };
  const narrative = executor.getNarrativeEntries();
  enableDevMode();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const subtree = getSubtreeSnapshot(snapshot, 'mount', narrative);
  expect(subtree?.subflowId).toBe('mount');
  expect(subtree?.executionTree.subflowId).toBe('mount');
  expect(subtree?.sharedState).toBeUndefined();
  expect(subtree?.history).toBeUndefined();
  expect(subtree?.narrativeEntries).toEqual(
    narrative.filter((entry) => entry.subflowId === 'mount' || (entry.type === 'subflow' && entry.stageId === 'mount')),
  );
  expect(subtree?.narrativeEntries?.length).toBeGreaterThan(0);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('sharedState will be undefined'));
  expect(getSubtreeSnapshot(snapshot, 'absent')).toBeUndefined();
  disableDevMode();
  getSubtreeSnapshot(snapshot, 'mount');
  expect(warn).toHaveBeenCalledTimes(1);

  // A stored tree can retain a mounted branch even when its separate result table is unavailable.
  const root = snapshot.executionTree;
  if (!root || !subtree) throw new Error('test run must retain its root and mounted subtree');
  const branched = {
    ...snapshot,
    executionTree: { ...root, children: [{ ...subtree.executionTree }], next: undefined },
  };
  expect(getSubtreeSnapshot(branched, 'mount')?.executionTree).toBe(branched.executionTree.children[0]);
});
