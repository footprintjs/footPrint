import { vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { NodeResolver } from '../../../../src/lib/engine/handlers/NodeResolver';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps } from '../../../../src/lib/engine/types';

function makeDeps(root: StageNode): HandlerDeps {
  return {
    stageMap: new Map(),
    root,
    executionRuntime: {},
    scopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
}

describe('NodeResolver', () => {
  describe('findNodeById', () => {
    it('finds root node by id', () => {
      const root: StageNode = { name: 'root', id: 'root-id' };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('root-id')).toBe(root);
    });

    it('finds nested node via next chain', () => {
      const target: StageNode = { name: 'target', id: 'target-id' };
      const root: StageNode = { name: 'root', id: 'root-id', next: target };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('target-id')).toBe(target);
    });

    it('finds node in children', () => {
      const child: StageNode = { name: 'child', id: 'child-id' };
      const root: StageNode = { name: 'root', id: 'root-id', children: [child] };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('child-id')).toBe(child);
    });

    it('returns undefined for missing node', () => {
      const root: StageNode = { name: 'root', id: 'root-id' };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('nonexistent')).toBeUndefined();
    });

    it('searches from custom start node', () => {
      const target: StageNode = { name: 'target', id: 'target-id' };
      const branch: StageNode = { name: 'branch', id: 'branch-id', next: target };
      const root: StageNode = { name: 'root', id: 'root-id' };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('target-id', branch)).toBe(target);
    });

    it('finds deeply nested children', () => {
      const deep: StageNode = { name: 'deep', id: 'deep-id' };
      const mid: StageNode = { name: 'mid', id: 'mid-id', children: [deep] };
      const root: StageNode = { name: 'root', id: 'root-id', children: [mid] };
      const resolver = new NodeResolver(makeDeps(root));
      expect(resolver.findNodeById('deep-id')).toBe(deep);
    });
  });

  describe('resolveSubflowReference', () => {
    it('returns node as-is when no $ref', () => {
      const node: StageNode = { name: 'subflow', isSubflowRoot: true, subflowId: 'sf1' };
      const deps = makeDeps({ name: 'root' });
      const resolver = new NodeResolver(deps);
      expect(resolver.resolveSubflowReference(node)).toBe(node);
    });

    it('resolves $ref from subflows dictionary', () => {
      const subflowRoot: StageNode = { name: 'actual-subflow' };
      const refNode: StageNode = { name: 'ref', $ref: 'sf1', isSubflowRoot: true, subflowId: 'sf1' };
      const deps = makeDeps({ name: 'root' });
      deps.subflows = { sf1: { root: subflowRoot } };
      const resolver = new NodeResolver(deps);

      const resolved = resolver.resolveSubflowReference(refNode);
      expect(resolved.name).toBe('actual-subflow');
    });
  });
});
