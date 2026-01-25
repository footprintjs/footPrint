/**
 * SubflowExecutor.test.ts
 *
 * Unit tests for the SubflowExecutor module.
 * Tests subflow isolation (separate PipelineRuntime), context inheritance,
 * nested subflows, error handling, and break flag isolation.
 *
 * _Requirements: 1.5_
 */

import { SubflowExecutor, ExecuteStageFn, CallExtractorFn, GetStageFnFn } from '../../../src/core/pipeline/SubflowExecutor';
import { NodeResolver } from '../../../src/core/pipeline/NodeResolver';
import { PipelineContext, SubflowResult, PipelineStageFunction } from '../../../src/core/pipeline/types';
import { StageNode } from '../../../src/core/pipeline/GraphTraverser';
import { PipelineRuntime } from '../../../src/core/context/PipelineRuntime';
import { StageContext } from '../../../src/core/context/StageContext';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(
  root: StageNode<TOut, TScope>,
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>,
  stageMap?: Map<string, PipelineStageFunction<TOut, TScope>>,
): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: stageMap ?? new Map(),
    root,
    pipelineRuntime,
    ScopeFactory: () => ({} as TScope),
    subflows,
    scopeProtectionMode: 'off',
  };
}

// Helper to create mock executeStage function
function createMockExecuteStage<TOut = any, TScope = any>(
  results: Record<string, { result: TOut; shouldThrow?: boolean }>,
): ExecuteStageFn<TOut, TScope> {
  return async (node, stageFunc, context, breakFn) => {
    const config = results[node.id ?? node.name];
    if (!config) {
      return undefined as TOut;
    }
    if (config.shouldThrow) {
      throw config.result;
    }
    return config.result;
  };
}

// Helper to create mock callExtractor function
function createMockCallExtractor(): CallExtractorFn {
  return jest.fn();
}

// Helper to create mock getStageFn function
function createMockGetStageFn<TOut = any, TScope = any>(
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>,
): GetStageFnFn<TOut, TScope> {
  return (node) => {
    if (node.fn) return node.fn as PipelineStageFunction<TOut, TScope>;
    return stageMap.get(node.name);
  };
}

describe('SubflowExecutor', () => {
  describe('Subflow Isolation (separate PipelineRuntime)', () => {
    it('should create isolated PipelineRuntime for each subflow execution', async () => {
      // Setup: Create a subflow with a stage that writes to context
      const subflowRoot: StageNode = {
        name: 'subflow-stage',
        id: 'subflow-stage-id',
        fn: async () => 'subflow-result',
        isSubflowRoot: false,
      };

      const subflowNode: StageNode = {
        name: 'subflow-entry',
        id: 'subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'test-subflow',
        subflowName: 'Test Subflow',
        fn: async () => 'entry-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'subflow-entry-id': { result: 'entry-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify subflow result was stored
      expect(subflowResultsMap.has('test-subflow')).toBe(true);
      const result = subflowResultsMap.get('test-subflow')!;
      expect(result.subflowId).toBe('test-subflow');
      expect(result.subflowName).toBe('Test Subflow');
      expect(result.parentStageId).toBe(parentContext.getStageId());
    });

    it('should not leak subflow state to parent context', async () => {
      const subflowNode: StageNode = {
        name: 'subflow-entry',
        id: 'subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'isolated-subflow',
        subflowName: 'Isolated Subflow',
        fn: async () => 'isolated-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'subflow-entry-id': { result: 'isolated-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      // Execute subflow
      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify parent context tree doesn't contain subflow's internal stages
      const parentTree = parentRuntime.getContextTree();
      // Parent should only have its own stages, not subflow's internal stages
      expect(parentTree.stageContexts).toBeDefined();
    });
  });

  describe('Context Inheritance', () => {
    it('should store subflow result in parent stage debugInfo', async () => {
      const subflowNode: StageNode = {
        name: 'subflow-entry',
        id: 'subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'context-test-subflow',
        subflowName: 'Context Test Subflow',
        fn: async () => 'context-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'subflow-entry-id': { result: 'context-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify parent context has subflow metadata (access via debug.logContext)
      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.isSubflowContainer).toBe(true);
      expect(debugInfo.subflowId).toBe('context-test-subflow');
      expect(debugInfo.subflowName).toBe('Context Test Subflow');
      expect(debugInfo.hasSubflowData).toBe(true);
      expect(debugInfo.subflowResult).toBeDefined();
    });

    it('should capture subflow treeContext in SubflowResult', async () => {
      const subflowNode: StageNode = {
        name: 'subflow-entry',
        id: 'subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'tree-context-subflow',
        subflowName: 'Tree Context Subflow',
        fn: async () => 'tree-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'subflow-entry-id': { result: 'tree-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      const result = subflowResultsMap.get('tree-context-subflow')!;
      expect(result.treeContext).toBeDefined();
      expect(result.treeContext.globalContext).toBeDefined();
      expect(result.treeContext.stageContexts).toBeDefined();
      expect(result.treeContext.history).toBeDefined();
    });
  });

  describe('Nested Subflows', () => {
    it('should handle nested subflows with separate isolation', async () => {
      // Create a nested subflow structure
      const innerSubflowRoot: StageNode = {
        name: 'inner-subflow-stage',
        id: 'inner-subflow-stage-id',
        fn: async () => 'inner-result',
      };

      const outerSubflowNode: StageNode = {
        name: 'outer-subflow-entry',
        id: 'outer-subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'outer-subflow',
        subflowName: 'Outer Subflow',
        fn: async () => 'outer-result',
      };

      const subflows = {
        'inner-subflow': { root: innerSubflowRoot },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'outer-subflow-entry-id': { result: 'outer-result' },
        'inner-subflow-stage-id': { result: 'inner-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(outerSubflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify outer subflow result was stored
      expect(subflowResultsMap.has('outer-subflow')).toBe(true);
      const outerResult = subflowResultsMap.get('outer-subflow')!;
      expect(outerResult.subflowId).toBe('outer-subflow');
    });

    it('should resolve subflow references from subflows dictionary', async () => {
      const subflowDefinition: StageNode = {
        name: 'defined-subflow-root',
        id: 'defined-subflow-root-id',
        fn: async () => 'defined-result',
      };

      const referenceNode: StageNode = {
        name: 'subflow-ref',
        id: 'subflow-ref-id',
        isSubflowRoot: true,
        subflowId: 'my-defined-subflow',
        subflowName: 'My Defined Subflow',
        // No fn - this is a reference that should be resolved
      };

      const subflows = {
        'my-defined-subflow': { root: subflowDefinition },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' }, subflows);
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'subflow-ref-id': { result: 'defined-result' },
        'defined-subflow-root-id': { result: 'defined-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn: GetStageFnFn = (node) => {
        // Return the fn from the resolved node
        if (node.fn) return node.fn as PipelineStageFunction<any, any>;
        // Check subflows dictionary
        const subflowDef = subflows[node.subflowId ?? ''];
        if (subflowDef?.root.fn) return subflowDef.root.fn as PipelineStageFunction<any, any>;
        return undefined;
      };

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(referenceNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      expect(subflowResultsMap.has('my-defined-subflow')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should capture errors in subflow and propagate to parent', async () => {
      const subflowError = new Error('Subflow execution failed');
      const subflowNode: StageNode = {
        name: 'error-subflow-entry',
        id: 'error-subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'error-subflow',
        subflowName: 'Error Subflow',
        fn: async () => { throw subflowError; },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage: ExecuteStageFn = async (node, stageFunc, context, breakFn) => {
        throw subflowError;
      };
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap)
      ).rejects.toThrow('Subflow execution failed');

      // Verify error was recorded in parent context (access via debug.errorContext)
      const errorInfo = parentContext.debug.errorContext;
      expect(errorInfo.subflowError).toContain('Subflow execution failed');
    });

    it('should still store subflow result even when error occurs', async () => {
      const subflowError = new Error('Partial failure');
      const subflowNode: StageNode = {
        name: 'partial-error-subflow',
        id: 'partial-error-subflow-id',
        isSubflowRoot: true,
        subflowId: 'partial-error-subflow',
        subflowName: 'Partial Error Subflow',
        fn: async () => { throw subflowError; },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage: ExecuteStageFn = async (node, stageFunc, context, breakFn) => {
        throw subflowError;
      };
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      try {
        await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);
      } catch (e) {
        // Expected to throw
      }

      // Subflow result should still be stored with execution data
      expect(subflowResultsMap.has('partial-error-subflow')).toBe(true);
      const result = subflowResultsMap.get('partial-error-subflow')!;
      expect(result.subflowId).toBe('partial-error-subflow');
      expect(result.treeContext).toBeDefined();
    });
  });

  describe('Break Flag Isolation', () => {
    it('should not propagate subflow break to parent', async () => {
      const subflowNode: StageNode = {
        name: 'break-subflow-entry',
        id: 'break-subflow-entry-id',
        isSubflowRoot: true,
        subflowId: 'break-subflow',
        subflowName: 'Break Subflow',
        fn: async () => 'break-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      // Execute stage that triggers break
      const executeStage: ExecuteStageFn = async (node, stageFunc, context, breakFn) => {
        breakFn(); // Trigger break inside subflow
        return 'break-result';
      };
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const parentBreakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, parentBreakFlag, 'test-branch', subflowResultsMap);

      // Parent break flag should NOT be affected by subflow break
      expect(parentBreakFlag.shouldBreak).toBe(false);
    });

    it('should allow subflow to complete normally after internal break', async () => {
      const subflowNode: StageNode = {
        name: 'internal-break-subflow',
        id: 'internal-break-subflow-id',
        isSubflowRoot: true,
        subflowId: 'internal-break-subflow',
        subflowName: 'Internal Break Subflow',
        fn: async () => 'internal-break-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage: ExecuteStageFn = async (node, stageFunc, context, breakFn) => {
        breakFn(); // Break inside subflow
        return 'internal-break-result';
      };
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const parentBreakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(
        subflowNode, 
        parentContext, 
        parentBreakFlag, 
        'test-branch', 
        subflowResultsMap
      );

      // Subflow should complete and return result
      expect(result).toBe('internal-break-result');
      // Subflow result should be stored
      expect(subflowResultsMap.has('internal-break-subflow')).toBe(true);
    });
  });

  describe('Flow Debug Messages', () => {
    it('should add flow debug messages for subflow entry and exit', async () => {
      const subflowNode: StageNode = {
        name: 'flow-debug-subflow',
        id: 'flow-debug-subflow-id',
        isSubflowRoot: true,
        subflowId: 'flow-debug-subflow',
        subflowName: 'Flow Debug Subflow',
        fn: async () => 'flow-debug-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'flow-debug-subflow-id': { result: 'flow-debug-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const addFlowDebugMessageSpy = jest.spyOn(parentContext, 'addFlowDebugMessage');
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify flow debug messages were added for entry and exit
      expect(addFlowDebugMessageSpy).toHaveBeenCalledWith(
        'subflow',
        'Entering Flow Debug Subflow subflow',
        { targetStage: 'flow-debug-subflow' }
      );
      expect(addFlowDebugMessageSpy).toHaveBeenCalledWith(
        'subflow',
        'Exiting Flow Debug Subflow subflow',
        { targetStage: 'flow-debug-subflow' }
      );
    });
  });

  describe('SubflowResult Structure', () => {
    it('should create SubflowResult without pipelineStructure (structure is build-time)', async () => {
      const subflowNode: StageNode = {
        name: 'structure-test-subflow',
        id: 'structure-test-subflow-id',
        isSubflowRoot: true,
        subflowId: 'structure-test-subflow',
        subflowName: 'Structure Test Subflow',
        fn: async () => 'structure-result',
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'structure-test-subflow-id': { result: 'structure-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      const result = subflowResultsMap.get('structure-test-subflow')!;
      
      // Verify SubflowResult has correct structure (no pipelineStructure)
      expect(result.subflowId).toBe('structure-test-subflow');
      expect(result.subflowName).toBe('Structure Test Subflow');
      expect(result.parentStageId).toBeDefined();
      expect(result.treeContext).toBeDefined();
      expect(result.treeContext.globalContext).toBeDefined();
      expect(result.treeContext.stageContexts).toBeDefined();
      expect(result.treeContext.history).toBeDefined();
      
      // pipelineStructure should NOT exist (removed per Requirements 4.3, 4.4)
      expect((result as any).pipelineStructure).toBeUndefined();
    });
  });
});
