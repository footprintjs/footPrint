/**
 * RuntimeStructureManager.test.ts
 *
 * Unit tests for the RuntimeStructureManager class and computeNodeType function.
 * Covers initialization, structure serialization, dynamic updates, and iteration tracking.
 */

import {
  RuntimeStructureManager,
  computeNodeType,
} from '../../../../src/core/executor/handlers/RuntimeStructureManager';
import type { StageNode } from '../../../../src/core/executor/Pipeline';
import type { SerializedPipelineStructure } from '../../../../src/core/builder/FlowChartBuilder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal StageNode for testing. */
function makeNode(overrides: Partial<StageNode> = {}): StageNode {
  return { name: 'test-node', ...overrides };
}

/** Creates a minimal SerializedPipelineStructure for testing. */
function makeStructure(
  overrides: Partial<SerializedPipelineStructure> = {},
): SerializedPipelineStructure {
  return { name: 'root', type: 'stage', ...overrides };
}

// ===========================================================================
// computeNodeType
// ===========================================================================

describe('computeNodeType', () => {
  it('returns "decider" when node has nextNodeDecider', () => {
    const node = makeNode({
      nextNodeDecider: (_output: any) => 'branch-a',
      children: [makeNode({ name: 'branch-a', id: 'branch-a' })],
    });
    expect(computeNodeType(node)).toBe('decider');
  });

  it('returns "decider" when node has nextNodeSelector', () => {
    const node = makeNode({
      nextNodeSelector: (_output: any) => ['branch-a'],
      children: [makeNode({ name: 'branch-a', id: 'branch-a' })],
    });
    expect(computeNodeType(node)).toBe('decider');
  });

  it('returns "decider" when node has deciderFn', () => {
    const node = makeNode({
      deciderFn: true,
      fn: async () => 'branch-a',
      children: [makeNode({ name: 'branch-a', id: 'branch-a' })],
    });
    expect(computeNodeType(node)).toBe('decider');
  });

  it('returns "streaming" when node.isStreaming is true', () => {
    const node = makeNode({ isStreaming: true, streamId: 'stream-1' });
    expect(computeNodeType(node)).toBe('streaming');
  });

  it('returns "fork" when node has children without decider/selector and no fn', () => {
    const node = makeNode({
      children: [
        makeNode({ name: 'child-a', id: 'child-a' }),
        makeNode({ name: 'child-b', id: 'child-b' }),
      ],
    });
    expect(computeNodeType(node)).toBe('fork');
  });

  it('returns "stage" when node has children with fn (dynamic children pattern)', () => {
    const node = makeNode({
      fn: async () => 'result',
      children: [makeNode({ name: 'child-a', id: 'child-a' })],
    });
    // When a node has children AND fn but no decider/selector, hasDynamicChildren is true,
    // so the fork condition is bypassed and it falls through to 'stage'.
    expect(computeNodeType(node)).toBe('stage');
  });

  it('returns "stage" by default for a plain node', () => {
    const node = makeNode({ name: 'plain' });
    expect(computeNodeType(node)).toBe('stage');
  });

  it('returns "stage" for a node with only next', () => {
    const node = makeNode({ next: makeNode({ name: 'next-node' }) });
    expect(computeNodeType(node)).toBe('stage');
  });

  it('decider takes precedence over streaming', () => {
    const node = makeNode({
      isStreaming: true,
      nextNodeDecider: (_output: any) => 'branch-a',
      children: [makeNode({ name: 'branch-a' })],
    });
    expect(computeNodeType(node)).toBe('decider');
  });

  it('returns "fork" when children exist with empty fn', () => {
    // children present, no fn, no decider/selector => fork
    const node = makeNode({
      children: [makeNode({ name: 'a' })],
    });
    expect(computeNodeType(node)).toBe('fork');
  });
});

// ===========================================================================
// RuntimeStructureManager
// ===========================================================================

describe('RuntimeStructureManager', () => {
  let manager: RuntimeStructureManager;

  beforeEach(() => {
    manager = new RuntimeStructureManager();
  });

  // ─────────────────────── init / getStructure ───────────────────────

  describe('init', () => {
    it('deep clones the build-time structure via JSON round-trip', () => {
      const buildTime = makeStructure({
        id: 'root-id',
        children: [makeStructure({ name: 'child', id: 'child-id', type: 'stage' })],
      });

      manager.init(buildTime);
      const runtime = manager.getStructure();

      // Values should be equal
      expect(runtime).toEqual(buildTime);
      // But not the same reference (deep clone)
      expect(runtime).not.toBe(buildTime);
      expect(runtime!.children![0]).not.toBe(buildTime.children![0]);
    });

    it('returns early if no structure provided', () => {
      manager.init(undefined);
      expect(manager.getStructure()).toBeUndefined();
    });

    it('returns early if called with no arguments', () => {
      manager.init();
      expect(manager.getStructure()).toBeUndefined();
    });

    it('builds node map so nodes are findable for updates', () => {
      const buildTime = makeStructure({
        id: 'root-id',
        children: [makeStructure({ name: 'child', id: 'child-id', type: 'stage' })],
        next: makeStructure({ name: 'next-node', id: 'next-id', type: 'stage' }),
      });

      manager.init(buildTime);

      // Verify the map works by attempting an update
      manager.updateIterationCount('child-id', 3);
      const structure = manager.getStructure();
      const child = structure!.children![0];
      expect(child.iterationCount).toBe(3);
    });

    it('builds node map including subflowStructure', () => {
      const subflowInner = makeStructure({ name: 'inner', id: 'inner-id', type: 'stage' });
      const buildTime = makeStructure({
        id: 'root-id',
        subflowStructure: subflowInner,
      });

      manager.init(buildTime);

      // Verify subflow inner node is reachable
      manager.updateIterationCount('inner-id', 5);
      expect(manager.getStructure()!.subflowStructure!.iterationCount).toBe(5);
    });
  });

  describe('getStructure', () => {
    it('returns undefined before init', () => {
      expect(manager.getStructure()).toBeUndefined();
    });

    it('returns the runtime structure after init', () => {
      const buildTime = makeStructure({ id: 'root-id' });
      manager.init(buildTime);
      expect(manager.getStructure()).toBeDefined();
      expect(manager.getStructure()!.id).toBe('root-id');
    });
  });

  // ─────────────────────── stageNodeToStructure ───────────────────────

  describe('stageNodeToStructure', () => {
    it('converts a basic node with name, id, displayName, description', () => {
      const node = makeNode({
        name: 'my-stage',
        id: 'stage-1',
        displayName: 'My Stage',
        description: 'Does something',
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.name).toBe('my-stage');
      expect(result.id).toBe('stage-1');
      expect(result.type).toBe('stage');
      expect(result.displayName).toBe('My Stage');
      expect(result.description).toBe('Does something');
    });

    it('sets isStreaming and streamId for streaming nodes', () => {
      const node = makeNode({ isStreaming: true, streamId: 'stream-42' });

      const result = manager.stageNodeToStructure(node);

      expect(result.isStreaming).toBe(true);
      expect(result.streamId).toBe('stream-42');
      expect(result.type).toBe('streaming');
    });

    it('sets isSubflowRoot, subflowId, subflowName for subflow root nodes', () => {
      const node = makeNode({
        isSubflowRoot: true,
        subflowId: 'sub-1',
        subflowName: 'My Subflow',
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.isSubflowRoot).toBe(true);
      expect(result.subflowId).toBe('sub-1');
      expect(result.subflowName).toBe('My Subflow');
    });

    it('sets hasDecider and branchIds for decider nodes (nextNodeDecider)', () => {
      const childA = makeNode({ name: 'branch-a', id: 'id-a' });
      const childB = makeNode({ name: 'branch-b', id: 'id-b' });
      const node = makeNode({
        nextNodeDecider: (_output: any) => 'id-a',
        children: [childA, childB],
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.hasDecider).toBe(true);
      expect(result.branchIds).toEqual(['id-a', 'id-b']);
      expect(result.type).toBe('decider');
    });

    it('sets hasDecider and branchIds for deciderFn nodes', () => {
      const childA = makeNode({ name: 'branch-a', id: 'id-a' });
      const node = makeNode({
        deciderFn: true,
        fn: async () => 'id-a',
        children: [childA],
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.hasDecider).toBe(true);
      expect(result.branchIds).toEqual(['id-a']);
    });

    it('falls back to child name when child has no id (decider branchIds)', () => {
      const childA = makeNode({ name: 'branch-a' }); // no id
      const node = makeNode({
        nextNodeDecider: (_output: any) => 'branch-a',
        children: [childA],
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.branchIds).toEqual(['branch-a']);
    });

    it('sets hasSelector and branchIds for selector nodes', () => {
      const childA = makeNode({ name: 'sel-a', id: 'sel-id-a' });
      const childB = makeNode({ name: 'sel-b', id: 'sel-id-b' });
      const node = makeNode({
        nextNodeSelector: (_output: any) => ['sel-id-a'],
        children: [childA, childB],
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.hasSelector).toBe(true);
      expect(result.branchIds).toEqual(['sel-id-a', 'sel-id-b']);
      expect(result.type).toBe('decider');
    });

    it('recursively converts children', () => {
      const childA = makeNode({ name: 'child-a', id: 'id-a' });
      const childB = makeNode({ name: 'child-b', id: 'id-b' });
      const node = makeNode({
        name: 'parent',
        children: [childA, childB],
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.children).toHaveLength(2);
      expect(result.children![0].name).toBe('child-a');
      expect(result.children![0].id).toBe('id-a');
      expect(result.children![1].name).toBe('child-b');
      expect(result.children![1].id).toBe('id-b');
    });

    it('recursively converts next chain', () => {
      const nextNext = makeNode({ name: 'next-next', id: 'nn-id' });
      const nextNode = makeNode({ name: 'next-node', id: 'n-id', next: nextNext });
      const node = makeNode({ name: 'root', next: nextNode });

      const result = manager.stageNodeToStructure(node);

      expect(result.next).toBeDefined();
      expect(result.next!.name).toBe('next-node');
      expect(result.next!.next).toBeDefined();
      expect(result.next!.next!.name).toBe('next-next');
    });

    it('includes subflowStructure from subflowDef.buildTimeStructure', () => {
      const subflowBuildTime = makeStructure({
        name: 'sub-root',
        id: 'sub-root-id',
        type: 'stage',
      });
      const node = makeNode({
        name: 'mount',
        subflowDef: {
          root: makeNode({ name: 'sub-root' }),
          buildTimeStructure: subflowBuildTime,
        },
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.subflowStructure).toBeDefined();
      expect(result.subflowStructure!.name).toBe('sub-root');
      expect(result.subflowStructure!.id).toBe('sub-root-id');
    });

    it('does not include subflowStructure when subflowDef has no buildTimeStructure', () => {
      const node = makeNode({
        name: 'mount',
        subflowDef: {
          root: makeNode({ name: 'sub-root' }),
        },
      });

      const result = manager.stageNodeToStructure(node);

      expect(result.subflowStructure).toBeUndefined();
    });

    it('handles a node with no optional properties', () => {
      const node = makeNode({ name: 'bare' });

      const result = manager.stageNodeToStructure(node);

      expect(result.name).toBe('bare');
      expect(result.type).toBe('stage');
      expect(result.children).toBeUndefined();
      expect(result.next).toBeUndefined();
      expect(result.isStreaming).toBeUndefined();
      expect(result.isSubflowRoot).toBeUndefined();
      expect(result.hasDecider).toBeUndefined();
      expect(result.hasSelector).toBeUndefined();
      expect(result.subflowStructure).toBeUndefined();
    });
  });

  // ─────────────────── updateDynamicChildren ───────────────────

  describe('updateDynamicChildren', () => {
    it('updates parent children with new serialized structures', () => {
      const buildTime = makeStructure({ id: 'parent-id', name: 'parent' });
      manager.init(buildTime);

      const dynamicChild1 = makeNode({ name: 'dyn-child-1', id: 'dc-1' });
      const dynamicChild2 = makeNode({ name: 'dyn-child-2', id: 'dc-2' });

      manager.updateDynamicChildren('parent-id', [dynamicChild1, dynamicChild2]);

      const structure = manager.getStructure();
      expect(structure!.children).toHaveLength(2);
      expect(structure!.children![0].name).toBe('dyn-child-1');
      expect(structure!.children![1].name).toBe('dyn-child-2');
    });

    it('registers new children in node map so they are reachable', () => {
      const buildTime = makeStructure({ id: 'parent-id', name: 'parent' });
      manager.init(buildTime);

      const dynamicChild = makeNode({ name: 'dyn-child', id: 'dc-1' });
      manager.updateDynamicChildren('parent-id', [dynamicChild]);

      // Verify child is in the map by updating its iteration count
      manager.updateIterationCount('dc-1', 7);
      const child = manager.getStructure()!.children![0];
      expect(child.iterationCount).toBe(7);
    });

    it('sets hasSelector flag and branchIds when hasSelector is true', () => {
      const buildTime = makeStructure({ id: 'parent-id', name: 'parent' });
      manager.init(buildTime);

      const dynamicChild = makeNode({ name: 'branch', id: 'b-1' });
      manager.updateDynamicChildren('parent-id', [dynamicChild], true, false);

      const structure = manager.getStructure();
      expect(structure!.hasSelector).toBe(true);
      expect(structure!.branchIds).toEqual(['b-1']);
    });

    it('sets hasDecider flag and branchIds when hasDecider is true', () => {
      const buildTime = makeStructure({ id: 'parent-id', name: 'parent' });
      manager.init(buildTime);

      const childA = makeNode({ name: 'branch-a', id: 'ba' });
      const childB = makeNode({ name: 'branch-b', id: 'bb' });
      manager.updateDynamicChildren('parent-id', [childA, childB], false, true);

      const structure = manager.getStructure();
      expect(structure!.hasDecider).toBe(true);
      expect(structure!.branchIds).toEqual(['ba', 'bb']);
    });

    it('uses child name as branchId fallback when child has no id', () => {
      const buildTime = makeStructure({ id: 'parent-id', name: 'parent' });
      manager.init(buildTime);

      const childNoId = makeNode({ name: 'no-id-child' }); // no id
      manager.updateDynamicChildren('parent-id', [childNoId], true);

      const structure = manager.getStructure();
      expect(structure!.branchIds).toEqual(['no-id-child']);
    });

    it('returns early if no runtime structure', () => {
      // manager.init() not called => no runtime structure
      // Should not throw
      expect(() =>
        manager.updateDynamicChildren('parent-id', [makeNode()]),
      ).not.toThrow();
    });

    it('warns and returns early if parent not found', () => {
      const buildTime = makeStructure({ id: 'root-id', name: 'root' });
      manager.init(buildTime);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      manager.updateDynamicChildren('nonexistent-id', [makeNode()]);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nonexistent-id'),
      );
      warnSpy.mockRestore();
    });
  });

  // ─────────────────── updateDynamicSubflow ───────────────────

  describe('updateDynamicSubflow', () => {
    it('updates mount node with subflow properties', () => {
      const buildTime = makeStructure({ id: 'mount-id', name: 'mount' });
      manager.init(buildTime);

      manager.updateDynamicSubflow('mount-id', 'sub-1', 'My Subflow');

      const structure = manager.getStructure();
      expect(structure!.isSubflowRoot).toBe(true);
      expect(structure!.subflowId).toBe('sub-1');
      expect(structure!.subflowName).toBe('My Subflow');
    });

    it('registers subflow build-time structure in node map', () => {
      const subflowStructure = makeStructure({
        name: 'sub-inner',
        id: 'sub-inner-id',
        type: 'stage',
      });
      const buildTime = makeStructure({ id: 'mount-id', name: 'mount' });
      manager.init(buildTime);

      manager.updateDynamicSubflow('mount-id', 'sub-1', 'Sub', subflowStructure);

      const structure = manager.getStructure();
      expect(structure!.subflowStructure).toBeDefined();
      expect(structure!.subflowStructure!.name).toBe('sub-inner');

      // Verify the inner node was registered in the map
      manager.updateIterationCount('sub-inner-id', 2);
      expect(structure!.subflowStructure!.iterationCount).toBe(2);
    });

    it('does not set subflowName when undefined', () => {
      const buildTime = makeStructure({ id: 'mount-id', name: 'mount' });
      manager.init(buildTime);

      manager.updateDynamicSubflow('mount-id', 'sub-1', undefined);

      const structure = manager.getStructure();
      expect(structure!.isSubflowRoot).toBe(true);
      expect(structure!.subflowId).toBe('sub-1');
      expect(structure!.subflowName).toBeUndefined();
    });

    it('does not set subflowStructure when no build-time structure provided', () => {
      const buildTime = makeStructure({ id: 'mount-id', name: 'mount' });
      manager.init(buildTime);

      manager.updateDynamicSubflow('mount-id', 'sub-1', 'Sub');

      const structure = manager.getStructure();
      expect(structure!.subflowStructure).toBeUndefined();
    });

    it('returns early if no runtime structure', () => {
      expect(() =>
        manager.updateDynamicSubflow('mount-id', 'sub-1'),
      ).not.toThrow();
    });

    it('warns and returns early if mount node not found', () => {
      const buildTime = makeStructure({ id: 'root-id', name: 'root' });
      manager.init(buildTime);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      manager.updateDynamicSubflow('nonexistent', 'sub-1');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nonexistent'),
      );
      warnSpy.mockRestore();
    });
  });

  // ─────────────────── updateDynamicNext ───────────────────

  describe('updateDynamicNext', () => {
    it('updates current node next with new serialized structure', () => {
      const buildTime = makeStructure({ id: 'current-id', name: 'current' });
      manager.init(buildTime);

      const dynamicNext = makeNode({ name: 'dyn-next', id: 'dyn-next-id' });
      manager.updateDynamicNext('current-id', dynamicNext);

      const structure = manager.getStructure();
      expect(structure!.next).toBeDefined();
      expect(structure!.next!.name).toBe('dyn-next');
      expect(structure!.next!.id).toBe('dyn-next-id');
    });

    it('registers next structure in node map', () => {
      const buildTime = makeStructure({ id: 'current-id', name: 'current' });
      manager.init(buildTime);

      const dynamicNext = makeNode({ name: 'dyn-next', id: 'dyn-next-id' });
      manager.updateDynamicNext('current-id', dynamicNext);

      // Verify the next node is in the map
      manager.updateIterationCount('dyn-next-id', 4);
      expect(manager.getStructure()!.next!.iterationCount).toBe(4);
    });

    it('returns early if no runtime structure', () => {
      expect(() =>
        manager.updateDynamicNext('current-id', makeNode()),
      ).not.toThrow();
    });

    it('warns and returns early if current node not found', () => {
      const buildTime = makeStructure({ id: 'root-id', name: 'root' });
      manager.init(buildTime);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      manager.updateDynamicNext('nonexistent', makeNode({ name: 'next' }));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nonexistent'),
      );
      warnSpy.mockRestore();
    });
  });

  // ─────────────────── updateIterationCount ───────────────────

  describe('updateIterationCount', () => {
    it('updates iteration count on existing node', () => {
      const buildTime = makeStructure({
        id: 'node-id',
        name: 'loop-node',
      });
      manager.init(buildTime);

      manager.updateIterationCount('node-id', 3);

      const structure = manager.getStructure();
      expect(structure!.iterationCount).toBe(3);
    });

    it('updates iteration count on deeply nested node', () => {
      const buildTime = makeStructure({
        id: 'root-id',
        name: 'root',
        children: [
          makeStructure({
            name: 'child',
            id: 'child-id',
            type: 'stage',
            next: makeStructure({ name: 'grandchild', id: 'gc-id', type: 'stage' }),
          }),
        ],
      });
      manager.init(buildTime);

      manager.updateIterationCount('gc-id', 10);

      const gc = manager.getStructure()!.children![0].next!;
      expect(gc.iterationCount).toBe(10);
    });

    it('returns early if no runtime structure', () => {
      // Should not throw when no structure initialized
      expect(() => manager.updateIterationCount('any-id', 5)).not.toThrow();
    });

    it('returns early if node not found', () => {
      const buildTime = makeStructure({ id: 'root-id', name: 'root' });
      manager.init(buildTime);

      // Should not throw, just silently return
      expect(() =>
        manager.updateIterationCount('nonexistent', 5),
      ).not.toThrow();

      // Existing node should be unaffected
      expect(manager.getStructure()!.iterationCount).toBeUndefined();
    });
  });

  // ─────────────────── buildNodeMap (via name fallback) ───────────────────

  describe('node map key fallback', () => {
    it('uses node name as key when id is absent', () => {
      const buildTime = makeStructure({ name: 'named-node', type: 'stage' });
      // No id on root
      manager.init(buildTime);

      manager.updateIterationCount('named-node', 2);

      expect(manager.getStructure()!.iterationCount).toBe(2);
    });

    it('prefers id over name when both are present', () => {
      const buildTime = makeStructure({
        name: 'my-name',
        id: 'my-id',
        type: 'stage',
      });
      manager.init(buildTime);

      // Update by id should work
      manager.updateIterationCount('my-id', 8);
      expect(manager.getStructure()!.iterationCount).toBe(8);
    });
  });

  // ─────────────────── Integration: stageNodeToStructure + updates ───────────────────

  describe('integration scenarios', () => {
    it('stageNodeToStructure produces a full structure for a complex node tree', () => {
      const grandchild = makeNode({ name: 'gc', id: 'gc-id' });
      const child1 = makeNode({ name: 'c1', id: 'c1-id', next: grandchild });
      const child2 = makeNode({
        name: 'c2',
        id: 'c2-id',
        isStreaming: true,
        streamId: 's-2',
      });
      const nextNode = makeNode({
        name: 'after',
        id: 'after-id',
        isSubflowRoot: true,
        subflowId: 'sf-1',
        subflowName: 'Subflow One',
      });
      const root = makeNode({
        name: 'root',
        id: 'root-id',
        displayName: 'Root Node',
        description: 'The entry point',
        children: [child1, child2],
        next: nextNode,
      });

      const result = manager.stageNodeToStructure(root);

      expect(result.name).toBe('root');
      expect(result.type).toBe('fork');
      expect(result.children).toHaveLength(2);
      expect(result.children![0].next!.name).toBe('gc');
      expect(result.children![1].isStreaming).toBe(true);
      expect(result.next!.isSubflowRoot).toBe(true);
      expect(result.next!.subflowName).toBe('Subflow One');
    });

    it('dynamic updates chain correctly together', () => {
      const buildTime = makeStructure({ id: 'root-id', name: 'root' });
      manager.init(buildTime);

      // Add dynamic children
      manager.updateDynamicChildren('root-id', [
        makeNode({ name: 'dc-1', id: 'dc-1' }),
        makeNode({ name: 'dc-2', id: 'dc-2' }),
      ]);

      // Add dynamic next to one of the children
      manager.updateDynamicNext('dc-1', makeNode({ name: 'chain', id: 'chain-id' }));

      // Add subflow to the chain node
      const subBuildTime = makeStructure({
        name: 'sub-start',
        id: 'sub-start-id',
        type: 'stage',
      });
      manager.updateDynamicSubflow('chain-id', 'sf-chain', 'Chain Subflow', subBuildTime);

      // Update iteration on the subflow node
      manager.updateIterationCount('sub-start-id', 3);

      const structure = manager.getStructure();
      const dc1 = structure!.children![0];
      const chain = dc1.next!;
      expect(chain.isSubflowRoot).toBe(true);
      expect(chain.subflowStructure!.iterationCount).toBe(3);
    });
  });
});
