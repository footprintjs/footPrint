/**
 * SelectorHandler.test.ts
 *
 * Unit tests for the SelectorHandler module.
 * Tests scope-based selector execution, multi-choice branching,
 * error handling, break semantics, and flow logging.
 *
 * Targets 100% code coverage of SelectorHandler.ts.
 */

import { SelectorHandler } from '../../../../src/core/executor/handlers/SelectorHandler';
import { ChildrenExecutor } from '../../../../src/core/executor/handlers/ChildrenExecutor';
import { PipelineContext, NodeResultType } from '../../../../src/core/executor/types';
import { StageNode } from '../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { NullNarrativeGenerator } from '../../../../src/core/executor/narrative/NullNarrativeGenerator';
import type { RunStageFn, ExecuteNodeFn, CallExtractorFn, GetStagePathFn } from '../../../../src/core/executor/handlers/DeciderHandler';

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
    logger: { info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
  };
}

// Helper to create a mock ChildrenExecutor
function createMockChildrenExecutor<TOut = any, TScope = any>(
  ctx: PipelineContext<TOut, TScope>,
): ChildrenExecutor<TOut, TScope> {
  const executor = new ChildrenExecutor(ctx, async () => 'child-result');
  return executor;
}

// Standard callback mocks
function createCallbacks() {
  const executionOrder: string[] = [];

  const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => {
    executionOrder.push('runStage');
    return fn({} as any, breakFn, undefined);
  };
  const executeNode: ExecuteNodeFn = async (node) => {
    executionOrder.push(`executeNode:${node.name}`);
    return `${node.name}-result`;
  };
  const callExtractor: CallExtractorFn = (_node, _ctx, _path, output) => {
    executionOrder.push('extractor');
  };
  const getStagePath: GetStagePathFn = (node, branchPath) =>
    branchPath ? `${branchPath}.${node.name}` : node.name;

  return { executionOrder, runStage, executeNode, callExtractor, getStagePath };
}

describe('SelectorHandler', () => {
  describe('handleScopeBased - basic execution', () => {
    it('should execute selector stage and run selected children in parallel', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);

      // Mock executeNodeChildren to track what children are passed
      let capturedChildren: StageNode[] = [];
      childrenExecutor.executeNodeChildren = jest.fn().mockImplementation(async (node) => {
        capturedChildren = node.children || [];
        const results: Record<string, NodeResultType> = {};
        for (const child of capturedChildren) {
          results[child.id!] = { id: child.id!, result: `${child.name}-result`, isError: false };
        }
        return results;
      });

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email' };
      const smsChild: StageNode = { name: 'SendSMS', id: 'sms' };
      const pushChild: StageNode = { name: 'SendPush', id: 'push' };

      const selectorNode: StageNode = {
        name: 'PickChannels',
        id: 'pick-channels',
        selectorFn: true,
        fn: () => ['email', 'sms'], // Returns array of branch IDs
        children: [emailChild, smsChild, pushChild],
      };

      const stageFunc = () => ['email', 'sms'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      const result = await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      // Should have executed children for email and sms only (not push)
      expect(childrenExecutor.executeNodeChildren).toHaveBeenCalledTimes(1);
      expect(capturedChildren).toHaveLength(2);
      expect(capturedChildren.map(c => c.id)).toEqual(['email', 'sms']);

      // Result should contain results for selected children
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('sms');
      expect(result).not.toHaveProperty('push');
    });

    it('should normalize single string return to array', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);

      let capturedChildren: StageNode[] = [];
      childrenExecutor.executeNodeChildren = jest.fn().mockImplementation(async (node) => {
        capturedChildren = node.children || [];
        return { email: { id: 'email', result: 'ok', isError: false } };
      });

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email' };
      const smsChild: StageNode = { name: 'SendSMS', id: 'sms' };

      const selectorNode: StageNode = {
        name: 'PickChannels',
        id: 'pick-channels',
        selectorFn: true,
        fn: () => 'email', // Returns single string
        children: [emailChild, smsChild],
      };

      const stageFunc = () => 'email'; // Single ID
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      // Should normalize to single-element array and pick email only
      expect(capturedChildren).toHaveLength(1);
      expect(capturedChildren[0].id).toBe('email');
    });
  });

  describe('handleScopeBased - execution order', () => {
    it('should follow: runStage → commit → extractor → resolve → execute children', async () => {
      const executionOrder: string[] = [];
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);

      childrenExecutor.executeNodeChildren = jest.fn().mockImplementation(async () => {
        executionOrder.push('executeChildren');
        return {};
      });

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => {
        executionOrder.push('stageFunc');
        return ['child-a'];
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => {
        executionOrder.push('runStage');
        return fn({} as any, breakFn, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => 'result';
      const callExtractor: CallExtractorFn = () => { executionOrder.push('extractor'); };
      const getStagePath: GetStagePathFn = () => 'main.selector';

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(executionOrder).toEqual(['runStage', 'stageFunc', 'extractor', 'executeChildren']);
    });
  });

  describe('handleScopeBased - empty selection', () => {
    it('should return empty results when selector returns empty array', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn();

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => []; // Empty selection
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      const result = await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(result).toEqual({});
      // ChildrenExecutor should NOT have been called
      expect(childrenExecutor.executeNodeChildren).not.toHaveBeenCalled();

      // Debug info should indicate skipped
      const logContext = stageContext.debug?.logContext;
      expect(logContext?.skippedAllChildren).toBe(true);
    });
  });

  describe('handleScopeBased - break semantics', () => {
    it('should stop execution when break flag is set during selector stage', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn();

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => ['child-a'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      // The runStage callback sets the break flag
      const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => {
        const output = fn({} as any, () => {
          breakFlag.shouldBreak = true;
        }, undefined);
        breakFn(); // Set break from runStage level
        return output;
      };
      const executeNode: ExecuteNodeFn = async () => 'result';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.selector';

      const result = await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      // Should return empty — children should NOT execute
      expect(result).toEqual({});
      expect(childrenExecutor.executeNodeChildren).not.toHaveBeenCalled();
    });
  });

  describe('handleScopeBased - error handling', () => {
    it('should commit patch and call extractor on stage error', async () => {
      const executionOrder: string[] = [];
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => {
        throw new Error('Selector failed');
      };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => {
        return fn({} as any, breakFn, undefined);
      };
      const executeNode: ExecuteNodeFn = async () => 'result';
      const callExtractor: CallExtractorFn = (_n, _c, _p, _o, errorInfo) => {
        executionOrder.push('extractor');
        if (errorInfo) executionOrder.push(`error:${errorInfo.type}`);
      };
      const getStagePath: GetStagePathFn = () => 'main.selector';

      await expect(
        handler.handleScopeBased(
          selectorNode, stageFunc, stageContext, breakFlag, 'main',
          runStage, executeNode, callExtractor, getStagePath,
        ),
      ).rejects.toThrow('Selector failed');

      // Extractor should be called with error info
      expect(executionOrder).toContain('extractor');
      expect(executionOrder).toContain('error:stageExecutionError');

      // Error should be recorded in context
      const errorInfo = stageContext.debug.errorContext;
      expect(errorInfo.stageExecutionError).toContain('Selector failed');
    });

    it('should throw on unknown child IDs', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [emailChild],
      };

      // Returns an ID that doesn't exist in children
      const stageFunc = () => ['email', 'unknown-channel'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await expect(
        handler.handleScopeBased(
          selectorNode, stageFunc, stageContext, breakFlag, 'main',
          runStage, executeNode, callExtractor, getStagePath,
        ),
      ).rejects.toThrow("Scope-based selector 'Selector' returned unknown child IDs: unknown-channel");

      // Error should be recorded
      const errorInfo = stageContext.debug.errorContext;
      expect(errorInfo.selectorError).toContain('unknown-channel');
    });
  });

  describe('handleScopeBased - debug info and flow messages', () => {
    it('should record selectedChildIds and selectorPattern in debug logs', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email' };
      const smsChild: StageNode = { name: 'SendSMS', id: 'sms' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [emailChild, smsChild],
      };

      const stageFunc = () => ['email'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      const logContext = stageContext.debug?.logContext;
      expect(logContext?.selectedChildIds).toEqual(['email']);
      expect(logContext?.selectorPattern).toBe('scope-based-multi-choice');
      expect(logContext?.skippedChildIds).toEqual(['sms']);
    });

    it('should add flow debug message for selected children', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email', displayName: 'Email Notification' };
      const smsChild: StageNode = { name: 'SendSMS', id: 'sms' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [emailChild, smsChild],
      };

      const stageFunc = () => ['email', 'sms'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      const flowMessages = stageContext.debug.flowMessages;
      expect(flowMessages.length).toBeGreaterThan(0);

      const selectedMsg = flowMessages.find((m) => m.type === 'selected');
      expect(selectedMsg).toBeDefined();
      expect(selectedMsg?.description).toContain('Email Notification');
      expect(selectedMsg?.description).toContain('SendSMS');
      expect(selectedMsg?.description).toContain('2 of 2');
    });

    it('should use displayName in narrative when available', async () => {
      // Use a real narrative generator spy to verify calls
      const narrativeGenerator = new NullNarrativeGenerator();
      const onSelectedSpy = jest.spyOn(narrativeGenerator, 'onSelected');

      const ctx = createTestContext();
      ctx.narrativeGenerator = narrativeGenerator;
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email', displayName: 'Email Channel' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        displayName: 'Channel Picker',
        selectorFn: true,
        children: [emailChild],
      };

      const stageFunc = () => ['email'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(onSelectedSpy).toHaveBeenCalledWith(
        'Channel Picker',
        ['Email Channel'],
        1,
      );
    });

    it('should not record skippedChildIds when all children are selected', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const emailChild: StageNode = { name: 'SendEmail', id: 'email' };
      const smsChild: StageNode = { name: 'SendSMS', id: 'sms' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [emailChild, smsChild],
      };

      const stageFunc = () => ['email', 'sms']; // Select all
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      const logContext = stageContext.debug?.logContext;
      // When all are selected, no skippedChildIds should be recorded
      expect(logContext?.skippedChildIds).toBeUndefined();
    });
  });

  describe('handleScopeBased - extractor is called with selectedIds', () => {
    it('should pass selectedIds to callExtractor as stageOutput', async () => {
      const ctx = createTestContext();
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => ['child-a'];
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      let capturedOutput: unknown;
      const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => fn({} as any, breakFn, undefined);
      const executeNode: ExecuteNodeFn = async () => 'result';
      const callExtractor: CallExtractorFn = (_n, _c, _p, output) => { capturedOutput = output; };
      const getStagePath: GetStagePathFn = () => 'main.selector';

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(capturedOutput).toEqual(['child-a']);
    });
  });

  describe('handleScopeBased - narrative calls', () => {
    it('should call onError narrative on stage failure', async () => {
      const narrativeGenerator = new NullNarrativeGenerator();
      const onErrorSpy = jest.spyOn(narrativeGenerator, 'onError');

      const ctx = createTestContext();
      ctx.narrativeGenerator = narrativeGenerator;
      const childrenExecutor = createMockChildrenExecutor(ctx);
      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        displayName: 'My Selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => { throw new Error('boom'); };
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };

      const runStage: RunStageFn = async (_node, fn, _ctx, breakFn) => fn({} as any, breakFn, undefined);
      const executeNode: ExecuteNodeFn = async () => 'result';
      const callExtractor: CallExtractorFn = () => {};
      const getStagePath: GetStagePathFn = () => 'main.selector';

      await expect(
        handler.handleScopeBased(
          selectorNode, stageFunc, stageContext, breakFlag, 'main',
          runStage, executeNode, callExtractor, getStagePath,
        ),
      ).rejects.toThrow('boom');

      expect(onErrorSpy).toHaveBeenCalledWith('Selector', expect.stringContaining('boom'), 'My Selector');
    });

    it('should call onSelected narrative for empty selection', async () => {
      const narrativeGenerator = new NullNarrativeGenerator();
      const onSelectedSpy = jest.spyOn(narrativeGenerator, 'onSelected');

      const ctx = createTestContext();
      ctx.narrativeGenerator = narrativeGenerator;
      const childrenExecutor = createMockChildrenExecutor(ctx);
      childrenExecutor.executeNodeChildren = jest.fn().mockResolvedValue({});

      const handler = new SelectorHandler(ctx, childrenExecutor);

      const child: StageNode = { name: 'Child', id: 'child-a' };
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        children: [child],
      };

      const stageFunc = () => []; // Empty
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(onSelectedSpy).toHaveBeenCalledWith('Selector', [], 1);
    });

    it('should handle node with undefined children in empty selection path', async () => {
      const narrativeGenerator = new NullNarrativeGenerator();
      const onSelectedSpy = jest.spyOn(narrativeGenerator, 'onSelected');

      const ctx = createTestContext();
      ctx.narrativeGenerator = narrativeGenerator;
      const childrenExecutor = createMockChildrenExecutor(ctx);
      const handler = new SelectorHandler(ctx, childrenExecutor);

      // Node without children array — defensive edge case
      const selectorNode: StageNode = {
        name: 'Selector',
        id: 'selector',
        selectorFn: true,
        // children intentionally omitted
      };

      const stageFunc = () => []; // Empty selection
      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFlag = { shouldBreak: false };
      const { runStage, executeNode, callExtractor, getStagePath } = createCallbacks();

      const result = await handler.handleScopeBased(
        selectorNode, stageFunc, stageContext, breakFlag, 'main',
        runStage, executeNode, callExtractor, getStagePath,
      );

      expect(result).toEqual({});
      // children ?? [] should default to [], so length = 0
      expect(onSelectedSpy).toHaveBeenCalledWith('Selector', [], 0);
    });
  });
});
