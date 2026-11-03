import { expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { prefixNodeTree } from '../../../src/lib/engine/graph/prefixNodeTree.js';
import type { StageNode } from '../../../src/lib/engine/graph/StageNode.js';
import { canonicalRunComponentRoot, copyRunComponentRoot } from '../../../src/lib/memory/RunComponent.js';

it('canonical metadata never retains a graph root as its stored value', () => {
  const source = { id: 'root', next: { id: 'later' } };
  const clone = { ...source };
  const writes = vi.spyOn(WeakMap.prototype, 'set');
  let values: unknown[];
  try {
    copyRunComponentRoot(source, clone);
    values = writes.mock.calls.map((entry) => entry[1]);
  } finally {
    writes.mockRestore();
  }
  expect(values).not.toContain(source);
  expect(values).not.toContain(clone);
});

it.each([1, 20, 100])('does constant metadata work for each of %i prefix clones', (size) => {
  let root: StageNode | undefined;
  for (let index = size - 1; index >= 0; index--)
    root = { name: `stage-${index}`, id: `stage-${index}`, ...(root && { next: root }) };
  const reads = vi.spyOn(WeakMap.prototype, 'get');
  const writes = vi.spyOn(WeakMap.prototype, 'set');
  let firstReads: number;
  let firstWrites: number;
  let secondReads: number;
  let secondWrites: number;
  try {
    const clone = prefixNodeTree(root!, 'first');
    firstReads = reads.mock.calls.length;
    firstWrites = writes.mock.calls.length;
    reads.mockClear();
    writes.mockClear();
    prefixNodeTree(clone, 'second');
    secondReads = reads.mock.calls.length;
    secondWrites = writes.mock.calls.length;
  } finally {
    reads.mockRestore();
    writes.mockRestore();
  }
  // Each node has one existing retry-budget lookup and one component-token lookup.
  expect(firstReads).toBe(size * 2);
  expect(firstWrites).toBe(size * 2);
  expect(secondReads).toBe(size * 2);
  expect(secondWrites).toBe(size);
});

it('does not look up graph identity at each ordinary stage', async () => {
  let builder = flowChart('root', () => undefined, 'root');
  for (let index = 0; index < 50; index++)
    builder = builder.addFunction(`stage-${index}`, () => undefined, `stage-${index}`);
  const chart = builder.build();
  const writes = vi.spyOn(WeakMap.prototype, 'set');
  let metadata: object | undefined;
  let token: object;
  let matchingWrites = 0;
  try {
    token = canonicalRunComponentRoot(chart.root);
    for (let index = 0; index < writes.mock.calls.length; index++) {
      const [key, value] = writes.mock.calls[index];
      const context = writes.mock.contexts[index];
      if (key === chart.root && value === token && typeof context === 'object' && context !== null) {
        metadata = context;
        matchingWrites++;
      }
    }
  } finally {
    writes.mockRestore();
  }
  expect(matchingWrites).toBe(1);
  expect(metadata).toBeDefined();
  expect(Object.isFrozen(token!)).toBe(true);
  expect(Object.keys(token!)).toEqual([]);
  const original = WeakMap.prototype.get;
  let identityReads = 0;
  const reads = vi
    .spyOn(WeakMap.prototype, 'get')
    .mockImplementation(function (this: WeakMap<object, unknown>, key: object) {
      if (this === metadata) identityReads++;
      return original.call(this, key);
    });
  try {
    await new FlowChartExecutor(chart).run();
  } finally {
    reads.mockRestore();
  }
  // One actual root entry, 51 ordinary stages. No per-stage metadata read.
  expect(identityReads).toBe(1);
});
