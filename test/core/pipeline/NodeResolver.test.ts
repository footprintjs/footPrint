/**
 * NodeResolver.test.ts
 *
 * Unit tests for the NodeResolver module.
 * Tests node lookup, subflow reference resolution, and decider evaluation.
 *
 * _Requirements: 3.4, 3.5_
 */

import { NodeResolver } from '../../../src/core/pipeline/NodeResolver';
import { PipelineContext } from '../../../src/core/pipeline/types';
import { StageNode } from '../../../src/core/pipeline/GraphTraverser';
import { StageContext } from '../../../src/core/context/StageContext';
import { PipelineRuntime } from '../../../src/core/context/PipelineRuntime';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(
  root: StageNode<TOut, TScope>,
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>,
): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root,
    pipelineRuntime,
    ScopeFactory: () => ({} as TScope),
    subflows,
    scopeProtectionMode: 'off',
  };
}

describe('NodeResolver', () => {
  describe('findNodeById', () => {
    it('should find root node by ID', () => {
      const root: StageNode = { name: 'root', id: 'root-id' };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      const found = resolver.findNodeById('root-id');
      expect(found).toBe(root);
    });

    it('should find node in linear chain', () => {
      const third: StageNode = { name: 'third', id: 'third-id' };
      const second: StageNode = { name: 'second', id: 'second-id', next: third };
      const root: StageNode = { name: 'root', id: 'root-id', next: second };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      expect(resolver.findNodeById('second-id')).toBe(second);
      expect(resolver.findNodeById('third-id')).toBe(third);
    });

    it('should find node in children (fork pattern)', () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const child2: StageNode = { name: 'child2', id: 'child2-id' };
      const root: StageNode = { name: 'root', id: 'root-id', children: [child1, child2] };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      expect(resolver.findNodeById('child1-id')).toBe(child1);
      expect(resolver.findNodeById('child2-id')).toBe(child2);
    });

    it('should find deeply nested node', () => {
      const deepNode: StageNode = { name: 'deep', id: 'deep-id' };
      const child: StageNode = { name: 'child', id: 'child-id', next: deepNode };
      const root: StageNode = { name: 'root', id: 'root-id', children: [child] };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      expect(resolver.findNodeById('deep-id')).toBe(deepNode);
    });

    it('should return undefined for non-existent ID', () => {
      const root: StageNode = { name: 'root', id: 'root-id' };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      expect(resolver.findNodeById('non-existent')).toBeUndefined();
    });

    it('should search from custom start node', () => {
      const target: StageNode = { name: 'target', id: 'target-id' };
      const branch: StageNode = { name: 'branch', id: 'branch-id', next: target };
      const root: StageNode = { name: 'root', id: 'root-id' };
      const ctx = createTestContext(root);
      const resolver = new NodeResolver(ctx);

      // Should not find target when searching from root (target not connected)
      expect(resolver.findNodeById('target-id')).toBeUndefined();
      // Should find target when searching from branch
      expect(resolver.findNodeById('target-id', branch)).toBe(target);
    });
  });

  describe('resolveSubflowReference', () => {
    it('should return node as-is if it has fn', () => {
      const fn = async () => 'result';
      const node: StageNode = { name: 'stage', id: 'stage-id', fn, isSubflowRoot: true, subflowId: 'sub' };
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved).toBe(node);
    });

    it('should return node as-is if it has children', () => {
      const child: StageNode = { name: 'child', id: 'child-id' };
      const node: StageNode = { name: 'stage', id: 'stage-id', children: [child], isSubflowRoot: true, subflowId: 'sub' };
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved).toBe(node);
    });

    it('should return node as-is if no subflows dictionary', () => {
      const node: StageNode = { name: 'stage', id: 'stage-id', isSubflowRoot: true, subflowId: 'sub' };
      const ctx = createTestContext({ name: 'root', id: 'root' }, undefined);
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved).toBe(node);
    });

    it('should resolve reference using subflowId', () => {
      const subflowRoot: StageNode = { name: 'subflow-root', id: 'subflow-root-id', fn: async () => 'sub' };
      const node: StageNode = { name: 'ref', id: 'ref-id', isSubflowRoot: true, subflowId: 'my-subflow', subflowName: 'My Subflow' };
      const subflows = { 'my-subflow': { root: subflowRoot } };
      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved).not.toBe(node);
      expect(resolved.fn).toBe(subflowRoot.fn);
      expect(resolved.isSubflowRoot).toBe(true);
      expect(resolved.subflowId).toBe('my-subflow');
      expect(resolved.subflowName).toBe('My Subflow');
    });

    it('should preserve reference metadata when resolving', () => {
      const subflowRoot: StageNode = { name: 'subflow-root', id: 'subflow-root-id', displayName: 'Original Name' };
      const node: StageNode = { 
        name: 'ref', 
        id: 'custom-mount-id', 
        isSubflowRoot: true, 
        subflowId: 'my-subflow', 
        subflowName: 'Custom Name',
        displayName: 'Custom Display'
      };
      const subflows = { 'my-subflow': { root: subflowRoot } };
      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved.id).toBe('custom-mount-id');
      expect(resolved.displayName).toBe('Custom Display');
      expect(resolved.subflowName).toBe('Custom Name');
    });

    it('should fallback to subflowName if subflowId not found', () => {
      const subflowRoot: StageNode = { name: 'subflow-root', id: 'subflow-root-id', fn: async () => 'sub' };
      const node: StageNode = { name: 'ref', id: 'ref-id', isSubflowRoot: true, subflowId: 'not-found', subflowName: 'fallback-key' };
      const subflows = { 'fallback-key': { root: subflowRoot } };
      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved.fn).toBe(subflowRoot.fn);
    });

    it('should return node as-is if subflow not found in dictionary', () => {
      const node: StageNode = { name: 'ref', id: 'ref-id', isSubflowRoot: true, subflowId: 'not-found' };
      const subflows = { 'other-subflow': { root: { name: 'other', id: 'other-id' } } };
      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const resolver = new NodeResolver(ctx);

      const resolved = resolver.resolveSubflowReference(node);
      expect(resolved).toBe(node);
    });
  });

  describe('getNextNode', () => {
    it('should return chosen child based on decider result', async () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const child2: StageNode = { name: 'child2', id: 'child2-id' };
      const children = [child1, child2];
      const decider = () => 'child2-id';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      const chosen = await resolver.getNextNode(decider, children);
      expect(chosen).toBe(child2);
    });

    it('should handle async decider', async () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const child2: StageNode = { name: 'child2', id: 'child2-id' };
      const children = [child1, child2];
      const decider = async () => 'child1-id';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      const chosen = await resolver.getNextNode(decider, children);
      expect(chosen).toBe(child1);
    });

    it('should pass input to decider', async () => {
      const child1: StageNode = { name: 'child1', id: 'yes' };
      const child2: StageNode = { name: 'child2', id: 'no' };
      const children = [child1, child2];
      const decider = (input: { shouldProceed: boolean }) => input.shouldProceed ? 'yes' : 'no';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      const chosen = await resolver.getNextNode(decider, children, { shouldProceed: true });
      expect(chosen).toBe(child1);
    });

    it('should throw if decider returns unknown ID', async () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const children = [child1];
      const decider = () => 'unknown-id';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);

      await expect(resolver.getNextNode(decider, children)).rejects.toThrow('Next Stage not found for unknown-id');
    });

    it('should add debug info to context if provided', async () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const children = [child1];
      const decider = () => 'child1-id';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);
      
      const pipelineRuntime = new PipelineRuntime('test');
      const stageContext = pipelineRuntime.rootStageContext;
      const addDebugInfoSpy = jest.spyOn(stageContext, 'addDebugInfo');

      await resolver.getNextNode(decider, children, undefined, stageContext);
      expect(addDebugInfoSpy).toHaveBeenCalledWith('nextNode', 'child1-id');
    });

    it('should add error info to context on failure', async () => {
      const child1: StageNode = { name: 'child1', id: 'child1-id' };
      const children = [child1];
      const decider = () => 'unknown-id';
      const ctx = createTestContext({ name: 'root', id: 'root' });
      const resolver = new NodeResolver(ctx);
      
      const pipelineRuntime = new PipelineRuntime('test');
      const stageContext = pipelineRuntime.rootStageContext;
      const addErrorInfoSpy = jest.spyOn(stageContext, 'addErrorInfo');

      await expect(resolver.getNextNode(decider, children, undefined, stageContext)).rejects.toThrow();
      expect(addErrorInfoSpy).toHaveBeenCalledWith('deciderError', 'Next Stage not found for unknown-id');
    });
  });
});
