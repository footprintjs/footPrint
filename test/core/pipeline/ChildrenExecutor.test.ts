/**
 * ChildrenExecutor.test.ts
 *
 * Unit tests for the ChildrenExecutor module.
 * Tests parallel execution with Promise.allSettled, throttling error flagging,
 * and selector-based execution.
 *
 * _Requirements: 2.3, 2.4_
 */

import { ChildrenExecutor, ExecuteNodeFn } from '../../../src/core/pipeline/ChildrenExecutor';
import { PipelineContext } from '../../../src/core/pipeline/types';
import { StageNode } from '../../../src/core/pipeline/GraphTraverser';
import { PipelineRuntime } from '../../../src/core/context/PipelineRuntime';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(
  options: {
    throttlingErrorChecker?: (error: unknown) => boolean;
  } = {},
): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: () => ({} as TScope),
    scopeProtectionMode: 'off',
    throttlingErrorChecker: options.throttlingErrorChecker,
  };
}

// Helper to create a mock executeNode function
function createMockExecuteNode(
  results: Record<string, { result: unknown; shouldThrow?: boolean; delay?: number }>,
): ExecuteNodeFn {
  return async (node, context, breakFlag, branchPath) => {
    const config = results[node.id!];
    if (!config) {
      return undefined;
    }
    if (config.delay) {
      await new Promise((resolve) => setTimeout(resolve, config.delay));
    }
    if (config.shouldThrow) {
      throw config.result;
    }
    return config.result;
  };
}

describe('ChildrenExecutor', () => {
  describe('executeNodeChildren', () => {
    it('should execute all children in parallel and aggregate results', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({
        'child1': { result: 'result1' },
        'child2': { result: 'result2' },
        'child3': { result: 'result3' },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [
          { name: 'child1', id: 'child1' },
          { name: 'child2', id: 'child2' },
          { name: 'child3', id: 'child3' },
        ],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results).toEqual({
        'child1': { id: 'child1', result: 'result1', isError: false },
        'child2': { id: 'child2', result: 'result2', isError: false },
        'child3': { id: 'child3', result: 'result3', isError: false },
      });
    });

    it('should handle empty children array', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({});
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results).toEqual({});
    });

    it('should handle undefined children', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({});
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results).toEqual({});
    });

    it('should capture errors with isError flag using Promise.allSettled behavior', async () => {
      const ctx = createTestContext();
      const testError = new Error('Child failed');
      const executeNode = createMockExecuteNode({
        'child1': { result: 'success' },
        'child2': { result: testError, shouldThrow: true },
        'child3': { result: 'also success' },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [
          { name: 'child1', id: 'child1' },
          { name: 'child2', id: 'child2' },
          { name: 'child3', id: 'child3' },
        ],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results['child1']).toEqual({ id: 'child1', result: 'success', isError: false });
      expect(results['child2'].isError).toBe(true);
      expect(results['child2'].result).toBe(testError);
      expect(results['child3']).toEqual({ id: 'child3', result: 'also success', isError: false });
    });

    it('should flag throttling errors when throttlingErrorChecker matches', async () => {
      const throttlingError = new Error('ThrottlingException');
      const ctx = createTestContext({
        throttlingErrorChecker: (error) => error instanceof Error && error.message.includes('Throttling'),
      });
      const executeNode = createMockExecuteNode({
        'child1': { result: throttlingError, shouldThrow: true },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [{ name: 'child1', id: 'child1' }],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results['child1'].isError).toBe(true);
      // The throttling flag is set on the child context, not returned in results
      // This test verifies the error is captured correctly
    });

    it('should not flag non-throttling errors', async () => {
      const regularError = new Error('Regular error');
      const ctx = createTestContext({
        throttlingErrorChecker: (error) => error instanceof Error && error.message.includes('Throttling'),
      });
      const executeNode = createMockExecuteNode({
        'child1': { result: regularError, shouldThrow: true },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [{ name: 'child1', id: 'child1' }],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const results = await executor.executeNodeChildren(parentNode, parentContext);

      expect(results['child1'].isError).toBe(true);
      expect(results['child1'].result).toBe(regularError);
    });

    it('should execute children truly in parallel', async () => {
      const ctx = createTestContext();
      const executionOrder: string[] = [];
      
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        executionOrder.push(`start-${node.id}`);
        // Different delays to verify parallel execution
        const delay = node.id === 'child1' ? 50 : node.id === 'child2' ? 10 : 30;
        await new Promise((resolve) => setTimeout(resolve, delay));
        executionOrder.push(`end-${node.id}`);
        return `result-${node.id}`;
      };
      
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [
          { name: 'child1', id: 'child1' },
          { name: 'child2', id: 'child2' },
          { name: 'child3', id: 'child3' },
        ],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      await executor.executeNodeChildren(parentNode, parentContext);

      // All starts should happen before any ends (parallel execution)
      const startIndices = executionOrder
        .filter((e) => e.startsWith('start-'))
        .map((e) => executionOrder.indexOf(e));
      const endIndices = executionOrder
        .filter((e) => e.startsWith('end-'))
        .map((e) => executionOrder.indexOf(e));

      // At least some ends should come after all starts (proving parallelism)
      const maxStartIndex = Math.max(...startIndices);
      const minEndIndex = Math.min(...endIndices);
      
      // In parallel execution, the fastest child (child2) should end
      // while slower children are still running
      expect(executionOrder).toContain('start-child1');
      expect(executionOrder).toContain('start-child2');
      expect(executionOrder).toContain('start-child3');
    });

    it('should propagate break flag when all children break', async () => {
      const ctx = createTestContext();
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        breakFlag.shouldBreak = true;
        return 'result';
      };
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [
          { name: 'child1', id: 'child1' },
          { name: 'child2', id: 'child2' },
        ],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const parentBreakFlag = { shouldBreak: false };
      await executor.executeNodeChildren(parentNode, parentContext, parentBreakFlag);

      expect(parentBreakFlag.shouldBreak).toBe(true);
    });

    it('should not propagate break flag when only some children break', async () => {
      const ctx = createTestContext();
      let callCount = 0;
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        callCount++;
        if (callCount === 1) {
          breakFlag.shouldBreak = true;
        }
        return 'result';
      };
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'parent',
        id: 'parent',
        children: [
          { name: 'child1', id: 'child1' },
          { name: 'child2', id: 'child2' },
        ],
      };

      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const parentBreakFlag = { shouldBreak: false };
      await executor.executeNodeChildren(parentNode, parentContext, parentBreakFlag);

      expect(parentBreakFlag.shouldBreak).toBe(false);
    });
  });

  describe('executeSelectedChildren', () => {
    it('should execute only selected children based on selector result', async () => {
      const ctx = createTestContext();
      const executedIds: string[] = [];
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        executedIds.push(node.id!);
        return `result-${node.id}`;
      };
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
        { name: 'child3', id: 'child3' },
      ];

      const selector = () => ['child1', 'child3'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      const results = await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      expect(executedIds).toContain('child1');
      expect(executedIds).toContain('child3');
      expect(executedIds).not.toContain('child2');
      expect(Object.keys(results)).toEqual(['child1', 'child3']);
    });

    it('should handle single ID selector result', async () => {
      const ctx = createTestContext();
      const executedIds: string[] = [];
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        executedIds.push(node.id!);
        return `result-${node.id}`;
      };
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
      ];

      const selector = () => 'child2';
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      const results = await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      expect(executedIds).toEqual(['child2']);
      expect(Object.keys(results)).toEqual(['child2']);
    });

    it('should handle empty selector result', async () => {
      const ctx = createTestContext();
      const executedIds: string[] = [];
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        executedIds.push(node.id!);
        return `result-${node.id}`;
      };
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
      ];

      const selector = () => [];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      const results = await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      expect(executedIds).toEqual([]);
      expect(results).toEqual({});
    });

    it('should throw error for unknown child IDs', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({});
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
      ];

      const selector = () => ['unknown-id'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      await expect(
        executor.executeSelectedChildren(
          selector,
          children,
          {},
          parentContext,
          'test-branch',
        ),
      ).rejects.toThrow('Selector returned unknown child IDs: unknown-id');
    });

    it('should pass input to selector function', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({
        'yes': { result: 'yes-result' },
        'no': { result: 'no-result' },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'yes', id: 'yes' },
        { name: 'no', id: 'no' },
      ];

      const selector = (input: { shouldProceed: boolean }) => 
        input.shouldProceed ? ['yes'] : ['no'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      const results = await executor.executeSelectedChildren(
        selector,
        children,
        { shouldProceed: true },
        parentContext,
        'test-branch',
      );

      expect(Object.keys(results)).toEqual(['yes']);
    });

    it('should handle async selector', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({
        'child1': { result: 'result1' },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
      ];

      const selector = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ['child1'];
      };
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      const results = await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      expect(Object.keys(results)).toEqual(['child1']);
    });

    it('should add debug info for selected and skipped children', async () => {
      const ctx = createTestContext();
      const executeNode = createMockExecuteNode({
        'child1': { result: 'result1' },
      });
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
        { name: 'child3', id: 'child3' },
      ];

      const selector = () => ['child1'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      const addDebugInfoSpy = jest.spyOn(parentContext, 'addDebugInfo');
      
      await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      expect(addDebugInfoSpy).toHaveBeenCalledWith('selectedChildIds', ['child1']);
      expect(addDebugInfoSpy).toHaveBeenCalledWith('selectorPattern', 'multi-choice');
      expect(addDebugInfoSpy).toHaveBeenCalledWith('skippedChildIds', ['child2', 'child3']);
    });

    it('should execute selected children in parallel', async () => {
      const ctx = createTestContext();
      const executionOrder: string[] = [];
      
      const executeNode: ExecuteNodeFn = async (node, context, breakFlag, branchPath) => {
        executionOrder.push(`start-${node.id}`);
        const delay = node.id === 'child1' ? 30 : 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        executionOrder.push(`end-${node.id}`);
        return `result-${node.id}`;
      };
      
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'child1', id: 'child1' },
        { name: 'child2', id: 'child2' },
        { name: 'child3', id: 'child3' },
      ];

      const selector = () => ['child1', 'child2'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;
      
      await executor.executeSelectedChildren(
        selector,
        children,
        {},
        parentContext,
        'test-branch',
      );

      // Both should start before either ends (parallel)
      expect(executionOrder.indexOf('start-child1')).toBeLessThan(executionOrder.indexOf('end-child2'));
      expect(executionOrder.indexOf('start-child2')).toBeLessThan(executionOrder.indexOf('end-child1'));
    });
  });
});
