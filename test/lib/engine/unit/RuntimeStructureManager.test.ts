import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { computeNodeType, RuntimeStructureManager } from '../../../../src/lib/engine/handlers/RuntimeStructureManager';

describe('computeNodeType', () => {
  it('returns "decider" for nodes with deciderFn', () => {
    expect(computeNodeType({ name: 'x', deciderFn: true } as any)).toBe('decider');
  });

  it('returns "selector" for nodes with selectorFn', () => {
    expect(computeNodeType({ name: 'x', selectorFn: true } as any)).toBe('selector');
  });

  it('returns "decider" for nodes with nextNodeSelector', () => {
    expect(computeNodeType({ name: 'x', nextNodeSelector: () => ['a'] } as any)).toBe('decider');
  });

  it('returns "decider" for nodes with deciderFn', () => {
    expect(computeNodeType({ name: 'x', deciderFn: true } as any)).toBe('decider');
  });

  it('returns "streaming" for streaming nodes', () => {
    expect(computeNodeType({ name: 'x', isStreaming: true } as any)).toBe('streaming');
  });

  it('returns "fork" for static children (no fn)', () => {
    expect(computeNodeType({ name: 'x', children: [{ name: 'a' }] } as any)).toBe('fork');
  });

  it('returns "stage" for simple nodes', () => {
    expect(computeNodeType({ name: 'x' } as any)).toBe('stage');
  });

  it('returns "stage" for nodes with fn and dynamic children', () => {
    // Dynamic children (has fn + children but no decider/selector) = stage
    expect(computeNodeType({ name: 'x', fn: () => {}, children: [{ name: 'a' }] } as any)).toBe('stage');
  });
});

describe('RuntimeStructureManager', () => {
  it('initializes from build-time structure', () => {
    const mgr = new RuntimeStructureManager();
    const structure = { name: 'root', id: 'root', type: 'stage' as const };
    mgr.init(structure);
    const result = mgr.getStructure();
    expect(result).toBeDefined();
    expect(result!.name).toBe('root');
    // Should be a deep clone
    expect(result).not.toBe(structure);
  });

  it('returns undefined when not initialized', () => {
    const mgr = new RuntimeStructureManager();
    expect(mgr.getStructure()).toBeUndefined();
  });

  it('updateDynamicChildren adds children to parent', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    const children: StageNode[] = [
      { name: 'a', id: 'a' },
      { name: 'b', id: 'b' },
    ];
    mgr.updateDynamicChildren('root', children);

    const result = mgr.getStructure()!;
    expect(result.children).toHaveLength(2);
    expect(result.children![0].name).toBe('a');
    expect(result.children![1].name).toBe('b');
  });

  it('updateDynamicSubflow marks node as subflow root', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    mgr.updateDynamicSubflow('root', 'sf1', 'My Subflow');

    const result = mgr.getStructure()!;
    expect(result.isSubflowRoot).toBe(true);
    expect(result.subflowId).toBe('sf1');
    expect(result.subflowName).toBe('My Subflow');
  });

  it('updateDynamicNext attaches next node', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    mgr.updateDynamicNext('root', { name: 'nextStage', id: 'next-id' });

    const result = mgr.getStructure()!;
    expect(result.next).toBeDefined();
    expect(result.next!.name).toBe('nextStage');
  });

  it('updateIterationCount sets iteration count', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    mgr.updateIterationCount('root', 3);

    const result = mgr.getStructure()!;
    expect(result.iterationCount).toBe(3);
  });

  it('stageNodeToStructure converts node recursively', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    const node: StageNode = {
      name: 'parent',
      id: 'parent-id',
      children: [{ name: 'child', id: 'child-id' }],
      next: { name: 'sibling', id: 'sib-id' },
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.name).toBe('parent');
    expect(result.children).toHaveLength(1);
    expect(result.next?.name).toBe('sibling');
  });

  it('stageNodeToStructure sets streaming properties', () => {
    const mgr = new RuntimeStructureManager();
    const node: StageNode = {
      name: 'streamNode',
      id: 'stream-1',
      isStreaming: true,
      streamId: 'sid-42',
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.isStreaming).toBe(true);
    expect(result.streamId).toBe('sid-42');
    expect(result.type).toBe('streaming');
  });

  it('stageNodeToStructure sets subflow root properties', () => {
    const mgr = new RuntimeStructureManager();
    const node: StageNode = {
      name: 'subflowMount',
      id: 'sf-mount-1',
      isSubflowRoot: true,
      subflowId: 'sf-123',
      subflowName: 'MySubflow',
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.isSubflowRoot).toBe(true);
    expect(result.subflowId).toBe('sf-123');
    expect(result.subflowName).toBe('MySubflow');
  });

  it('stageNodeToStructure sets hasDecider and branchIds for deciderFn nodes', () => {
    const mgr = new RuntimeStructureManager();
    const node: StageNode = {
      name: 'deciderNode',
      id: 'dec-1',
      deciderFn: () => 'branchA',
      children: [
        { name: 'branchA', id: 'ba' },
        { name: 'branchB', id: 'bb' },
      ],
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.hasDecider).toBe(true);
    expect(result.branchIds).toEqual(['ba', 'bb']);
    expect(result.type).toBe('decider');
  });

  it('stageNodeToStructure sets hasSelector and branchIds for nextNodeSelector nodes', () => {
    const mgr = new RuntimeStructureManager();
    const node: StageNode = {
      name: 'selectorNode',
      id: 'sel-1',
      nextNodeSelector: () => ['x'],
      children: [
        { name: 'optA', id: 'oa' },
        { name: 'optB', id: 'optB' },
      ],
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.hasSelector).toBe(true);
    expect(result.branchIds).toEqual(['oa', 'optB']);
    expect(result.type).toBe('decider');
  });

  it('stageNodeToStructure includes subflowDef.buildTimeStructure', () => {
    const mgr = new RuntimeStructureManager();
    const subStructure = { name: 'inner', id: 'inner-1', type: 'stage' as const };
    const node: StageNode = {
      name: 'withSubflow',
      id: 'ws-1',
      subflowDef: { buildTimeStructure: subStructure },
    };
    const result = mgr.stageNodeToStructure(node);
    expect(result.subflowStructure).toBeDefined();
    expect(result.subflowStructure!.name).toBe('inner');
  });

  it('updateDynamicChildren sets hasSelector and branchIds when hasSelector is true', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    const children: StageNode[] = [
      { name: 'c1', id: 'c1' },
      { name: 'c2', id: 'c2' },
    ];
    mgr.updateDynamicChildren('root', children, true);

    const result = mgr.getStructure()!;
    expect(result.hasSelector).toBe(true);
    expect(result.branchIds).toEqual(['c1', 'c2']);
    expect(result.children).toHaveLength(2);
  });

  it('updateDynamicChildren sets hasDecider and branchIds when hasDecider is true', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    const children: StageNode[] = [
      { name: 'd1', id: 'd1' },
      { name: 'd2', id: 'd2' },
    ];
    mgr.updateDynamicChildren('root', children, false, true);

    const result = mgr.getStructure()!;
    expect(result.hasDecider).toBe(true);
    expect(result.branchIds).toEqual(['d1', 'd2']);
  });

  it('updateDynamicSubflow attaches buildTimeStructure and registers in node map', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init({ name: 'root', id: 'root', type: 'stage' });

    const subStructure = { name: 'subRoot', id: 'sub-root', type: 'stage' as const };
    mgr.updateDynamicSubflow('root', 'sf-99', 'SubflowX', subStructure);

    const result = mgr.getStructure()!;
    expect(result.subflowStructure).toBeDefined();
    expect(result.subflowStructure!.name).toBe('subRoot');
    expect(result.subflowStructure!.id).toBe('sub-root');
  });

  it('operations on uninitialized manager are no-ops', () => {
    const mgr = new RuntimeStructureManager();
    // None of these should throw
    mgr.updateDynamicChildren('any', [{ name: 'x', id: 'x' }]);
    mgr.updateDynamicSubflow('any', 'sf');
    mgr.updateDynamicNext('any', { name: 'n', id: 'n' });
    mgr.updateIterationCount('any', 5);
    expect(mgr.getStructure()).toBeUndefined();
  });

  it('init with undefined is a no-op', () => {
    const mgr = new RuntimeStructureManager();
    mgr.init(undefined);
    expect(mgr.getStructure()).toBeUndefined();
  });
});
