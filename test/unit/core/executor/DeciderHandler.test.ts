/**
 * DeciderHandler.test.ts
 *
 * Unit tests for the DeciderHandler module.
 * Tests decider execution order, decider context creation,
 * and flow logging for branches.
 *
 * _Requirements: phase2-handlers 2.2, 2.3, 2.4, 2.5_
 */

import { DeciderHandler, RunStageFn, ExecuteNodeFn, CallExtractorFn, GetStagePathFn } from '../../../../src/core/executor/handlers/DeciderHandler';
import { NodeResolver } from '../../../../src/core/executor/handlers/NodeResolver';
import { PipelineContext } from '../../../../src/core/executor/types';
import { StageNode, Decider } from '../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { StageContext } from '../../../../src/core/memory/StageContext';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: (_context, stageName) => ({ stageName } as unknown as TScope),
    scopeProtectionMode: 'off',
  };
}

// Helper to create a NodeResolver with predefined nodes
function createNodeResolver<TOut = any, TScope = any>(
  nodes: StageNode<TOut, TScope>[],
  deciderResult?: StageNode<TOut, TScope>,
): NodeResolver<TOut, TScope> {
  const ctx = createTestContext<TOut, TScope>();
  ctx.root = nodes[0] || { name: 'root', id: 'root' };
  
  // Build stageMap from nodes
  for (const node of nodes) {
    ctx.stageMap.set(node.name, node);
  }
  
  const resolver = new NodeResolver(ctx);
  
  // Mock getNextNode if deciderResult is provided
  if (deciderResult) {
    resolver.getNextNode = jest.fn().mockResolvedValue(deciderResult);
  }
  
  return resolver;
}

describe('DeciderHandler', () => {
  describe('decider execution order', () => {
    it('should execute stage before decider when stage function exists', async () => {
      const executionOrder: string[] = [];
      
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => {
        executionOrder.push('stage');
        return 'stage-result';
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, _breakFn) => {
        return fn({} as any, () => {}, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => {
        executionOrder.push('executeNode');
        return 'executed';
      };
      const callExtractor: CallExtractorFn = () => {
        executionOrder.push('extractor');
      };
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        stageFunc,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      expect(executionOrder).toEqual(['stage', 'extractor', 'executeNode']);
    });

    it('should skip stage execution when no stage function', async () => {
      const executionOrder: string[] = [];
      
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => {
        executionOrder.push('stage');
        return 'stage-result';
      };
      const executeNode: ExecuteNodeFn = async () => {
        executionOrder.push('executeNode');
        return 'executed';
      };
      const callExtractor: CallExtractorFn = () => {
        executionOrder.push('extractor');
      };
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined, // No stage function
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      // Stage and extractor should not be called
      expect(executionOrder).toEqual(['executeNode']);
    });

    it('should stop execution when break flag is set', async () => {
      const executionOrder: string[] = [];
      
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => 'stage-result';
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, _fn, _ctx, breakFn) => {
        executionOrder.push('stage');
        breakFn(); // Set break flag
        return 'stage-result';
      };
      const executeNode: ExecuteNodeFn = async () => {
        executionOrder.push('executeNode');
        return 'executed';
      };
      const callExtractor: CallExtractorFn = () => {
        executionOrder.push('extractor');
      };
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      const result = await handler.handle(
        deciderNode,
        stageFunc,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      // Should stop after stage, not execute decider or child
      expect(executionOrder).toEqual(['stage', 'extractor']);
      expect(result).toBe('stage-result');
    });
  });

  describe('decider context creation', () => {
    it('should create decider context when stage function exists', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => 'stage-result';
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        stageFunc,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      // Check that a decider context was created (via createDeciderContext)
      const snapshot = stageContext.getSnapshot();
      // The decider context should be in the tree
      expect(snapshot.next?.name).toBe('decider');
      expect(snapshot.next?.isDecider).toBe(true);
    });

    it('should mark current context as decider when no stage function', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined, // No stage function
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      // The root context should be marked as decider
      expect(stageContext.isDecider).toBe(true);
    });
  });

  describe('flow logging for branches', () => {
    it('should add flow debug message for branch decision', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      const flowMessages = stageContext.debug.flowMessages;
      expect(flowMessages.length).toBeGreaterThan(0);
      
      const branchMessage = flowMessages.find((m) => m.type === 'branch');
      expect(branchMessage).toBeDefined();
      expect(branchMessage?.description).toContain('childA');
      expect(branchMessage?.targetStage).toBe('childA');
    });

    it('should use displayName in flow message when available', async () => {
      const childNode: StageNode = { 
        name: 'childA', 
        id: 'child-a', 
        displayName: 'Child Display Name',
        fn: () => 'child-result',
      };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      const flowMessages = stageContext.debug.flowMessages;
      const branchMessage = flowMessages.find((m) => m.type === 'branch');
      expect(branchMessage?.description).toContain('Child Display Name');
    });

    it('should include rationale in flow message when available', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      // Set decider rationale in context via the global store
      // The getValue call in DeciderHandler uses path=[] and key='deciderRationale'
      // which translates to globalStore.getValue(pipelineId, [], 'deciderRationale')
      ctx.pipelineRuntime.globalStore.setValue(stageContext.pipelineId, [], 'deciderRationale', 'User selected option A');
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      const flowMessages = stageContext.debug.flowMessages;
      const branchMessage = flowMessages.find((m) => m.type === 'branch');
      expect(branchMessage?.description).toContain('User selected option A');
      expect(branchMessage?.rationale).toBe('User selected option A');
    });
  });

  describe('error handling', () => {
    it('should commit patch and call extractor on stage error', async () => {
      const executionOrder: string[] = [];
      
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => {
        throw new Error('Stage failed');
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, _breakFn) => {
        return fn({} as any, () => {}, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => {
        executionOrder.push('executeNode');
        return 'executed';
      };
      const callExtractor: CallExtractorFn = () => {
        executionOrder.push('extractor');
      };
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await expect(
        handler.handle(
          deciderNode,
          stageFunc,
          stageContext,
          breakFlag,
          'main',
          runStage,
          executeNode,
          callExtractor,
          getStagePath,
        ),
      ).rejects.toThrow('Stage failed');

      // Extractor should be called even on error
      expect(executionOrder).toContain('extractor');
      // executeNode should NOT be called
      expect(executionOrder).not.toContain('executeNode');
    });

    it('should add error info to context on stage error', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => {
        throw new Error('Stage failed');
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, _breakFn) => {
        return fn({} as any, () => {}, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await expect(
        handler.handle(
          deciderNode,
          stageFunc,
          stageContext,
          breakFlag,
          'main',
          runStage,
          executeNode,
          callExtractor,
          getStagePath,
        ),
      ).rejects.toThrow('Stage failed');

      const errorInfo = stageContext.debug.errorContext;
      expect(errorInfo.stageExecutionError).toContain('Stage failed');
    });
  });

  describe('chosen child execution', () => {
    it('should execute chosen child with correct context', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      let capturedNode: StageNode | undefined;
      let capturedContext: StageContext | undefined;
      const runStage: RunStageFn = async () => 'stage-result';
      const executeNode: ExecuteNodeFn = async (node, context) => {
        capturedNode = node;
        capturedContext = context;
        return 'executed';
      };
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        undefined,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      expect(capturedNode).toBe(childNode);
      expect(capturedContext?.stageName).toBe('childA');
    });

    it('should pass stage output to NodeResolver.getNextNode', async () => {
      const childNode: StageNode = { name: 'childA', id: 'child-a', fn: () => 'child-result' };
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }], childNode);
      const handler = new DeciderHandler(ctx, nodeResolver);

      let capturedOutput: any;
      nodeResolver.getNextNode = jest.fn().mockImplementation(async (_decider, _children, output) => {
        capturedOutput = output;
        return childNode;
      });

      const deciderNode: StageNode = {
        name: 'deciderStage',
        id: 'decider',
        fn: () => 'stage-result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };
      const stageFunc = () => 'my-stage-output';
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, _breakFn) => {
        return fn({} as any, () => {}, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => 'executed';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.deciderStage';

      await handler.handle(
        deciderNode,
        stageFunc,
        stageContext,
        breakFlag,
        'main',
        runStage,
        executeNode,
        callExtractor,
        getStagePath,
      );

      expect(capturedOutput).toBe('my-stage-output');
    });
  });
});
