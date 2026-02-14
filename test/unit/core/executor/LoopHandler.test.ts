/**
 * LoopHandler.test.ts
 *
 * Unit tests for the LoopHandler module.
 * Tests iteration counter monotonicity, iterated stage name format,
 * dynamicNext resolution, and flow logging for loop-backs.
 *
 * _Requirements: phase2-handlers 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
 */

import { LoopHandler, ExecuteNodeFn } from '../../../../src/core/executor/handlers/LoopHandler';
import { NodeResolver } from '../../../../src/core/executor/handlers/NodeResolver';
import { PipelineContext } from '../../../../src/core/executor/types';
import { StageNode } from '../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { NullNarrativeGenerator } from '../../../../src/core/executor/narrative/NullNarrativeGenerator';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: (_context, stageName) => ({ stageName } as unknown as TScope),
    scopeProtectionMode: 'off',
    narrativeGenerator: new NullNarrativeGenerator(),
  };
}

// Helper to create a NodeResolver with predefined nodes
function createNodeResolver<TOut = any, TScope = any>(
  nodes: StageNode<TOut, TScope>[],
): NodeResolver<TOut, TScope> {
  const ctx = createTestContext<TOut, TScope>();
  ctx.root = nodes[0] || { name: 'root', id: 'root' };
  
  // Build stageMap from nodes
  for (const node of nodes) {
    ctx.stageMap.set(node.name, node);
  }
  
  return new NodeResolver(ctx);
}

describe('LoopHandler', () => {
  describe('iteration counter monotonicity', () => {
    it('should return 0 for first visit to a node', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const iteration = handler.getAndIncrementIteration('node1');
      expect(iteration).toBe(0);
    });

    it('should increment counter on each visit', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      expect(handler.getAndIncrementIteration('node1')).toBe(0);
      expect(handler.getAndIncrementIteration('node1')).toBe(1);
      expect(handler.getAndIncrementIteration('node1')).toBe(2);
      expect(handler.getAndIncrementIteration('node1')).toBe(3);
    });

    it('should track separate counters for different nodes', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      expect(handler.getAndIncrementIteration('nodeA')).toBe(0);
      expect(handler.getAndIncrementIteration('nodeB')).toBe(0);
      expect(handler.getAndIncrementIteration('nodeA')).toBe(1);
      expect(handler.getAndIncrementIteration('nodeC')).toBe(0);
      expect(handler.getAndIncrementIteration('nodeB')).toBe(1);
      expect(handler.getAndIncrementIteration('nodeA')).toBe(2);
    });
  });

  describe('iterated stage name format', () => {
    it('should return base name for iteration 0', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      expect(handler.getIteratedStageName('askLLM', 0)).toBe('askLLM');
    });

    it('should append .1 for iteration 1', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      expect(handler.getIteratedStageName('askLLM', 1)).toBe('askLLM.1');
    });

    it('should append .N for iteration N', () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      expect(handler.getIteratedStageName('processData', 5)).toBe('processData.5');
      expect(handler.getIteratedStageName('processData', 100)).toBe('processData.100');
    });
  });

  describe('dynamicNext resolution - string reference', () => {
    it('should resolve string reference to existing node', async () => {
      const targetNode: StageNode = { name: 'targetStage', id: 'target-id', fn: () => 'result' };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      let executedNode: StageNode | undefined;
      const executeNode: ExecuteNodeFn = async (node) => {
        executedNode = node;
        return 'executed';
      };

      await handler.handle('target-id', currentNode, stageContext, breakFlag, 'main', executeNode);

      expect(executedNode).toBe(targetNode);
    });

    it('should throw error for non-existent string reference', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await expect(
        handler.handle('non-existent-id', currentNode, stageContext, breakFlag, 'main', executeNode),
      ).rejects.toThrow('dynamicNext target node not found: non-existent-id');
    });

    it('should add debug info for string reference', async () => {
      const targetNode: StageNode = { name: 'targetStage', id: 'target-id', fn: () => 'result' };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await handler.handle('target-id', currentNode, stageContext, breakFlag, 'main', executeNode);

      const debugInfo = stageContext.debug.logContext;
      expect(debugInfo.dynamicNextTarget).toBe('target-id');
      expect(debugInfo.dynamicNextIteration).toBe(0);
    });
  });

  describe('dynamicNext resolution - StageNode with fn', () => {
    it('should execute StageNode with fn directly', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const dynamicNode: StageNode = { name: 'dynamicStage', id: 'dynamic', fn: () => 'dynamic-result' };
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      let executedNode: StageNode | undefined;
      const executeNode: ExecuteNodeFn = async (node) => {
        executedNode = node;
        return 'executed';
      };

      await handler.handle(dynamicNode, currentNode, stageContext, breakFlag, 'main', executeNode);

      expect(executedNode).toBe(dynamicNode);
    });

    it('should add debug info for direct node', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const dynamicNode: StageNode = { name: 'dynamicStage', id: 'dynamic', fn: () => 'result' };
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await handler.handle(dynamicNode, currentNode, stageContext, breakFlag, 'main', executeNode);

      const debugInfo = stageContext.debug.logContext;
      expect(debugInfo.dynamicNextDirect).toBe(true);
      expect(debugInfo.dynamicNextName).toBe('dynamicStage');
    });
  });

  describe('dynamicNext resolution - StageNode without fn (reference)', () => {
    it('should resolve StageNode reference by ID', async () => {
      const targetNode: StageNode = { name: 'targetStage', id: 'target-id', fn: () => 'result' };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      // Reference node without fn - should look up by ID
      const referenceNode: StageNode = { name: 'ref', id: 'target-id' };
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      let executedNode: StageNode | undefined;
      const executeNode: ExecuteNodeFn = async (node) => {
        executedNode = node;
        return 'executed';
      };

      await handler.handle(referenceNode, currentNode, stageContext, breakFlag, 'main', executeNode);

      expect(executedNode).toBe(targetNode);
    });

    it('should throw error for reference node without id', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      // Reference node without fn AND without id
      const referenceNode: StageNode = { name: 'ref' } as StageNode;
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await expect(
        handler.handle(referenceNode, currentNode, stageContext, breakFlag, 'main', executeNode),
      ).rejects.toThrow('dynamicNext node must have an id when used as reference');
    });

    it('should throw error for non-existent reference node', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const referenceNode: StageNode = { name: 'ref', id: 'non-existent' };
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await expect(
        handler.handle(referenceNode, currentNode, stageContext, breakFlag, 'main', executeNode),
      ).rejects.toThrow('dynamicNext target node not found: non-existent');
    });
  });

  describe('flow logging for loop-backs', () => {
    it('should add flow debug message for string reference loop', async () => {
      const targetNode: StageNode = { name: 'targetStage', id: 'target-id', fn: () => 'result' };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await handler.handle('target-id', currentNode, stageContext, breakFlag, 'main', executeNode);

      const flowMessages = stageContext.debug.flowMessages;
      expect(flowMessages.length).toBeGreaterThan(0);
      
      const loopMessage = flowMessages.find((m) => m.type === 'loop');
      expect(loopMessage).toBeDefined();
      expect(loopMessage?.description).toContain('Looping back to');
      expect(loopMessage?.description).toContain('iteration 1');
    });

    it('should add flow debug message for direct node', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      const dynamicNode: StageNode = { name: 'dynamicStage', id: 'dynamic', fn: () => 'result' };
      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await handler.handle(dynamicNode, currentNode, stageContext, breakFlag, 'main', executeNode);

      const flowMessages = stageContext.debug.flowMessages;
      expect(flowMessages.length).toBeGreaterThan(0);
      
      const nextMessage = flowMessages.find((m) => m.type === 'next');
      expect(nextMessage).toBeDefined();
      expect(nextMessage?.description).toContain('Moving to');
      expect(nextMessage?.description).toContain('dynamic');
    });

    it('should use displayName in flow message when available', async () => {
      const targetNode: StageNode = { 
        name: 'targetStage', 
        id: 'target-id', 
        displayName: 'Target Display Name',
        fn: () => 'result',
      };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const executeNode: ExecuteNodeFn = async () => 'executed';

      await handler.handle('target-id', currentNode, stageContext, breakFlag, 'main', executeNode);

      const flowMessages = stageContext.debug.flowMessages;
      const loopMessage = flowMessages.find((m) => m.type === 'loop');
      expect(loopMessage?.description).toContain('Target Display Name');
    });
  });

  describe('context creation', () => {
    it('should create next context with iterated stage name for loops', async () => {
      const targetNode: StageNode = { name: 'targetStage', id: 'target-id', fn: () => 'result' };
      const nodes: StageNode[] = [
        { name: 'root', id: 'root', next: targetNode },
        targetNode,
      ];
      
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver(nodes);
      const handler = new LoopHandler(ctx, nodeResolver);

      const currentNode: StageNode = { name: 'currentStage', id: 'current' };
      const breakFlag = { shouldBreak: false };

      const capturedContexts: StageContext[] = [];
      const executeNode: ExecuteNodeFn = async (_node, context) => {
        capturedContexts.push(context);
        return 'executed';
      };

      // First call - iteration 0, creates fresh context each time
      const stageContext1 = ctx.pipelineRuntime.rootStageContext;
      await handler.handle('target-id', currentNode, stageContext1, breakFlag, 'main', executeNode);
      expect(capturedContexts[0]?.stageName).toBe('targetStage');

      // Second call - iteration 1, use a fresh parent context to avoid caching
      const stageContext2 = new StageContext('main', 'parent2', {}, '', []);
      await handler.handle('target-id', currentNode, stageContext2, breakFlag, 'main', executeNode);
      expect(capturedContexts[1]?.stageName).toBe('targetStage.1');
    });

    it('should pass correct iteration to iterated stage name', async () => {
      const ctx = createTestContext();
      const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
      const handler = new LoopHandler(ctx, nodeResolver);

      // Verify iteration counter increments correctly
      expect(handler.getAndIncrementIteration('test-node')).toBe(0);
      expect(handler.getIteratedStageName('stage', 0)).toBe('stage');
      
      expect(handler.getAndIncrementIteration('test-node')).toBe(1);
      expect(handler.getIteratedStageName('stage', 1)).toBe('stage.1');
      
      expect(handler.getAndIncrementIteration('test-node')).toBe(2);
      expect(handler.getIteratedStageName('stage', 2)).toBe('stage.2');
    });
  });
});
