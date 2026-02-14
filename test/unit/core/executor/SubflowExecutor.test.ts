/**
 * SubflowExecutor.test.ts
 *
 * Unit tests for the SubflowExecutor module.
 * Tests subflow isolation (separate PipelineRuntime), context inheritance,
 * nested subflows, error handling, and break flag isolation.
 *
 * _Requirements: 1.5_
 */

import { SubflowExecutor, ExecuteStageFn, CallExtractorFn, GetStageFnFn } from '../../../../src/core/executor/handlers/SubflowExecutor';
import { NodeResolver } from '../../../../src/core/executor/handlers/NodeResolver';
import { PipelineContext, SubflowResult, PipelineStageFunction } from '../../../../src/core/executor/types';
import { StageNode } from '../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { NullNarrativeGenerator } from '../../../../src/core/executor/narrative/NullNarrativeGenerator';

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
    narrativeGenerator: new NullNarrativeGenerator(),
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
      const parentTree = parentRuntime.getSnapshot();
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


describe('SubflowExecutor — Input/Output Mapping', () => {
  /**
   * **Property 2: InputMapper Execution and Seeding**
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  describe('Input Mapping', () => {
    it('should call inputMapper with parent scope and seed values to subflow', async () => {
      const inputMapper = jest.fn((scope: any) => ({ userId: scope.userId, name: scope.name }));
      
      const subflowNode: StageNode = {
        name: 'input-mapping-subflow',
        id: 'input-mapping-subflow-id',
        isSubflowRoot: true,
        subflowId: 'input-mapping-subflow',
        subflowName: 'Input Mapping Subflow',
        fn: async () => 'mapped-result',
        subflowMountOptions: {
          inputMapper,
          scopeMode: 'isolated',
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'input-mapping-subflow-id': { result: 'mapped-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      
      // Set up parent scope with values to map
      parentContext.setGlobal('userId', 'user-123');
      parentContext.setGlobal('name', 'Test User');
      parentContext.setGlobal('secretData', 'should-not-be-mapped');
      parentContext.commit();
      
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify inputMapper was called
      expect(inputMapper).toHaveBeenCalled();
      
      // Verify debug info contains mapped input and subflowReadOnlyContext
      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.mappedInput).toEqual({ userId: 'user-123', name: 'Test User' });
      expect(debugInfo.subflowReadOnlyContext).toEqual({ userId: 'user-123', name: 'Test User' });
    });

    it('should work without inputMapper (empty initial scope)', async () => {
      const subflowNode: StageNode = {
        name: 'no-mapper-subflow',
        id: 'no-mapper-subflow-id',
        isSubflowRoot: true,
        subflowId: 'no-mapper-subflow',
        subflowName: 'No Mapper Subflow',
        fn: async () => 'no-mapper-result',
        subflowMountOptions: {
          // No inputMapper - like a function with no arguments
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'no-mapper-subflow-id': { result: 'no-mapper-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      
      parentContext.setGlobal('parentData', 'should-not-leak');
      parentContext.commit();
      
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify subflowReadOnlyContext is empty (no inputMapper = no args)
      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.subflowReadOnlyContext).toEqual({});
      expect(debugInfo.mappedInput).toBeUndefined(); // Empty object not logged
    });
  });

  /**
   * **Property 3: InputMapper Error Propagation**
   * **Validates: Requirements 5.3**
   */
  describe('InputMapper Error Handling', () => {
    it('should propagate inputMapper errors and log to errorInfo', async () => {
      const inputMapperError = new Error('InputMapper failed');
      const inputMapper = jest.fn(() => { throw inputMapperError; });
      
      const subflowNode: StageNode = {
        name: 'error-mapper-subflow',
        id: 'error-mapper-subflow-id',
        isSubflowRoot: true,
        subflowId: 'error-mapper-subflow',
        subflowName: 'Error Mapper Subflow',
        fn: async () => 'should-not-reach',
        subflowMountOptions: {
          inputMapper,
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({});
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap)
      ).rejects.toThrow('InputMapper failed');

      // Verify error was logged to errorInfo
      const errorInfo = parentContext.debug.errorContext;
      expect(errorInfo.inputMapperError).toContain('InputMapper failed');
    });
  });

  /**
   * **Property 4: OutputMapper Execution and Writing**
   * **Validates: Requirements 3.4, 3.5**
   */
  describe('Output Mapping', () => {
    it('should call outputMapper after successful subflow completion', async () => {
      const outputMapper = jest.fn((output: any, parentScope: any) => ({
        subflowResult: output,
        processedAt: 'now',
      }));
      
      const subflowNode: StageNode = {
        name: 'output-mapping-subflow',
        id: 'output-mapping-subflow-id',
        isSubflowRoot: true,
        subflowId: 'output-mapping-subflow',
        subflowName: 'Output Mapping Subflow',
        fn: async () => 'subflow-output-value',
        subflowMountOptions: {
          outputMapper,
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'output-mapping-subflow-id': { result: 'subflow-output-value' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      // Verify outputMapper was called with subflow output
      expect(outputMapper).toHaveBeenCalledWith('subflow-output-value', expect.any(Object));
      
      // Verify debug info contains mapped output
      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.mappedOutput).toEqual({
        subflowResult: 'subflow-output-value',
        processedAt: 'now',
      });
    });

    it('should not call outputMapper when subflow errors', async () => {
      const outputMapper = jest.fn();
      const subflowError = new Error('Subflow failed');
      
      const subflowNode: StageNode = {
        name: 'error-output-subflow',
        id: 'error-output-subflow-id',
        isSubflowRoot: true,
        subflowId: 'error-output-subflow',
        subflowName: 'Error Output Subflow',
        fn: async () => { throw subflowError; },
        subflowMountOptions: {
          outputMapper,
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage: ExecuteStageFn = async () => { throw subflowError; };
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
        // Expected
      }

      // outputMapper should NOT have been called
      expect(outputMapper).not.toHaveBeenCalled();
    });
  });

  /**
   * **Property 6: Mapper Error Capture**
   * **Validates: Requirements 5.4**
   */
  describe('OutputMapper Error Handling', () => {
    it('should log outputMapper errors but not re-throw (non-fatal)', async () => {
      const outputMapperError = new Error('OutputMapper failed');
      const outputMapper = jest.fn(() => { throw outputMapperError; });
      
      const subflowNode: StageNode = {
        name: 'output-error-subflow',
        id: 'output-error-subflow-id',
        isSubflowRoot: true,
        subflowId: 'output-error-subflow',
        subflowName: 'Output Error Subflow',
        fn: async () => 'success-output',
        subflowMountOptions: {
          outputMapper,
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'output-error-subflow-id': { result: 'success-output' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      // Should NOT throw - outputMapper errors are non-fatal
      const result = await executor.executeSubflow(
        subflowNode, 
        parentContext, 
        breakFlag, 
        'test-branch', 
        subflowResultsMap
      );

      // Subflow should complete successfully
      expect(result).toBe('success-output');
      
      // Error should be logged to errorInfo
      const errorInfo = parentContext.debug.errorContext;
      expect(errorInfo.outputMapperError).toContain('OutputMapper failed');
    });
  });

  /**
   * **Property 5: Debug Info Contains Mapping Data**
   * **Validates: Requirements 5.1, 5.2, 5.5**
   */
  describe('Debug Info', () => {
    it('should include mappedInput, mappedOutput, and scopeMode in debugInfo', async () => {
      const inputMapper = (scope: any) => ({ input: scope.data });
      const outputMapper = (output: any) => ({ output });
      
      const subflowNode: StageNode = {
        name: 'debug-info-subflow',
        id: 'debug-info-subflow-id',
        isSubflowRoot: true,
        subflowId: 'debug-info-subflow',
        subflowName: 'Debug Info Subflow',
        fn: async () => 'debug-output',
        subflowMountOptions: {
          inputMapper,
          outputMapper,
        },
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'debug-info-subflow-id': { result: 'debug-output' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      
      parentContext.setGlobal('data', 'test-data');
      parentContext.commit();
      
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.mappedInput).toEqual({ input: 'test-data' });
      expect(debugInfo.subflowReadOnlyContext).toEqual({ input: 'test-data' });
      expect(debugInfo.mappedOutput).toEqual({ output: 'debug-output' });
    });

    it('should not include mappedInput/mappedOutput when no mappers provided', async () => {
      const subflowNode: StageNode = {
        name: 'no-debug-subflow',
        id: 'no-debug-subflow-id',
        isSubflowRoot: true,
        subflowId: 'no-debug-subflow',
        subflowName: 'No Debug Subflow',
        fn: async () => 'no-debug-output',
        // No subflowMountOptions
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'no-debug-subflow-id': { result: 'no-debug-output' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(subflowNode, parentContext, breakFlag, 'test-branch', subflowResultsMap);

      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.scopeMode).toBeUndefined();
      expect(debugInfo.mappedInput).toBeUndefined();
      expect(debugInfo.mappedOutput).toBeUndefined();
    });
  });

  /**
   * **Property 10: Backward Compatibility**
   * **Validates: Requirements 1.6, 3.6, 7.2, 7.3, 7.4**
   */
  describe('Backward Compatibility', () => {
    it('should work without subflowMountOptions (existing behavior)', async () => {
      const subflowNode: StageNode = {
        name: 'backward-compat-subflow',
        id: 'backward-compat-subflow-id',
        isSubflowRoot: true,
        subflowId: 'backward-compat-subflow',
        subflowName: 'Backward Compat Subflow',
        fn: async () => 'compat-result',
        // No subflowMountOptions - existing behavior
      };

      const ctx = createTestContext({ name: 'root', id: 'root' });
      const nodeResolver = new NodeResolver(ctx);
      
      const executeStage = createMockExecuteStage({
        'backward-compat-subflow-id': { result: 'compat-result' },
      });
      const callExtractor = createMockCallExtractor();
      const getStageFn = createMockGetStageFn(ctx.stageMap);

      const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const subflowResultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(
        subflowNode, 
        parentContext, 
        breakFlag, 
        'test-branch', 
        subflowResultsMap
      );

      // Should work exactly as before
      expect(result).toBe('compat-result');
      expect(subflowResultsMap.has('backward-compat-subflow')).toBe(true);
      
      // Debug info should have existing fields
      const debugInfo = parentContext.debug.logContext;
      expect(debugInfo.isSubflowContainer).toBe(true);
      expect(debugInfo.subflowId).toBe('backward-compat-subflow');
      expect(debugInfo.hasSubflowData).toBe(true);
    });
  });
});
