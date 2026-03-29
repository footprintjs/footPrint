/**
 * Tests for the SelectorFnList type correction (P4-9).
 *
 * Fix: SelectorFnList.end() previously set `this.curSpec.type = 'decider'` even though
 * the node is a selector (not a decider). This was semantically incorrect — visualization
 * tools and any code inspecting the spec type would confuse selectors with deciders.
 *
 * Fix adds 'selector' to the SerializedPipelineStructure.type union and:
 * - SelectorFnList.end() now sets type = 'selector'
 * - computeNodeType() returns 'selector' for selectorFn nodes
 * - stageNodeToStructure() sets hasSelector for selectorFn nodes
 *
 * Deciders retain type = 'decider'.
 */

import { flowChart } from '../../../../src/index';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { computeNodeType, RuntimeStructureManager } from '../../../../src/lib/engine/handlers/RuntimeStructureManager';

const noop = async () => {};

// ---------------------------------------------------------------------------
// Pattern 1: unit — selector spec gets type='selector', decider gets type='decider'
// ---------------------------------------------------------------------------
describe('selector type fix — unit: correct type in buildTimeStructure', () => {
  it('addSelectorFunction sets type=selector in the spec', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addSelectorFunction('Pick', async () => 'a' as any, 'pick')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .build();

    // Walk the buildTimeStructure to find the selector node
    const selectorNode = chart.buildTimeStructure.next;
    expect(selectorNode?.type).toBe('selector');
    expect(selectorNode?.hasSelector).toBe(true);
    expect(selectorNode?.hasDecider).toBeFalsy();
  });

  it('addDeciderFunction retains type=decider in the spec', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addDeciderFunction('Decide', async () => 'a' as any, 'decide')
      .addFunctionBranch('a', 'A', noop)
      .setDefault('a')
      .end()
      .build();

    const deciderNode = chart.buildTimeStructure.next;
    expect(deciderNode?.type).toBe('decider');
    expect(deciderNode?.hasDecider).toBe(true);
    expect(deciderNode?.hasSelector).toBeFalsy();
  });

  it('computeNodeType returns selector for selectorFn nodes', () => {
    const node = { name: 'x', selectorFn: true } as unknown as StageNode;
    expect(computeNodeType(node)).toBe('selector');
  });

  it('computeNodeType returns decider for deciderFn nodes', () => {
    const node = { name: 'x', deciderFn: true } as unknown as StageNode;
    expect(computeNodeType(node)).toBe('decider');
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — selectors and deciders are distinct but both have branchIds
// ---------------------------------------------------------------------------
describe('selector type fix — boundary: type distinctness with branchIds', () => {
  it('selector spec has both type=selector and branchIds set', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addSelectorFunction('MultiPick', async () => 'a' as any, 'multi')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .build();

    const node = chart.buildTimeStructure.next;
    expect(node?.type).toBe('selector');
    expect(node?.branchIds).toBeDefined();
    expect(node?.branchIds?.length).toBeGreaterThan(0);
  });

  it('decider spec has type=decider and branchIds set', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addDeciderFunction('Decide', async () => 'a' as any, 'decide')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .setDefault('a')
      .end()
      .build();

    const node = chart.buildTimeStructure.next;
    expect(node?.type).toBe('decider');
    expect(node?.branchIds).toBeDefined();
    expect(node?.branchIds?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — a pipeline with both a selector and a decider
// ---------------------------------------------------------------------------
describe('selector type fix — scenario: mixed pipeline types', () => {
  it('pipeline with selector then decider has distinct types in structure', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addSelectorFunction('PickFeatures', async () => 'fast' as any, 'pick')
      .addFunctionBranch('fast', 'Fast', noop)
      .addFunctionBranch('slow', 'Slow', noop)
      .end()
      .addFunction('Middle', noop, 'middle')
      .addDeciderFunction('Route', async () => 'path-a' as any, 'route')
      .addFunctionBranch('path-a', 'PathA', noop)
      .addFunctionBranch('path-b', 'PathB', noop)
      .setDefault('path-a')
      .end()
      .build();

    // Walk to find selector node (entry → pick)
    const selectorNode = chart.buildTimeStructure.next;
    expect(selectorNode?.type).toBe('selector');
    expect(selectorNode?.hasSelector).toBe(true);

    // Middle node is a stage
    const middleNode = selectorNode?.next;
    expect(middleNode?.type).toBe('stage');

    // Route is a decider
    const deciderNode = middleNode?.next;
    expect(deciderNode?.type).toBe('decider');
    expect(deciderNode?.hasDecider).toBe(true);
  });

  it('RuntimeStructureManager.stageNodeToStructure sets selector type for selectorFn nodes', () => {
    const mgr = new RuntimeStructureManager();
    const node: StageNode = {
      name: 'selectorNode',
      id: 'sel-1',
      selectorFn: true,
      children: [
        { name: 'optA', id: 'oa' },
        { name: 'optB', id: 'ob' },
      ],
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.type).toBe('selector');
    expect(result.hasSelector).toBe(true);
    expect(result.branchIds).toEqual(['oa', 'ob']);
    expect(result.hasDecider).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — 'selector' type is always paired with hasSelector=true
// ---------------------------------------------------------------------------
describe('selector type fix — property: type/hasSelector invariant', () => {
  it('any spec with type=selector has hasSelector=true', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addSelectorFunction('S', async () => 'x' as any, 's')
      .addFunctionBranch('x', 'X', noop)
      .end()
      .build();

    const node = chart.buildTimeStructure.next;
    if (node?.type === 'selector') {
      expect(node.hasSelector).toBe(true);
    }
  });

  it('any spec with type=decider and deciderFn has hasDecider=true (not hasSelector)', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addDeciderFunction('D', async () => 'x' as any, 'd')
      .addFunctionBranch('x', 'X', noop)
      .setDefault('x')
      .end()
      .build();

    const node = chart.buildTimeStructure.next;
    if (node?.type === 'decider') {
      expect(node.hasDecider).toBe(true);
      expect(node.hasSelector).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — type mislabeling does not affect execution behavior
// ---------------------------------------------------------------------------
describe('selector type fix — security: execution is unaffected by type label', () => {
  it('selector pipeline executes correctly after type fix', async () => {
    const { FlowChartExecutor } = await import('../../../../src/index');
    let executed = false;

    const chart = flowChart('Entry', async () => {}, 'entry')
      .addSelectorFunction('S', async () => 'branch-a' as any, 's')
      .addFunctionBranch('branch-a', 'BranchA', async () => {
        executed = true;
      })
      .end()
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run();
    expect(executed).toBe(true);
  });

  it('type=selector does not appear in decider queries and vice versa', () => {
    const chart = flowChart('Entry', noop, 'entry')
      .addSelectorFunction('S', async () => 'a' as any, 's')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .build();

    const selectorNode = chart.buildTimeStructure.next;
    // Selector nodes must NOT be misidentified as deciders
    expect(selectorNode?.type).not.toBe('decider');
    expect(selectorNode?.hasDecider).toBeFalsy();
  });
});
