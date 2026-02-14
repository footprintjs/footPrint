/**
 * handler-narrative-integration.test.ts
 *
 * Unit tests for narrative integration across all handler modules.
 * Verifies that each handler calls the correct INarrativeGenerator methods
 * with the correct arguments during pipeline traversal.
 *
 * BUSINESS CONTEXT:
 * The narrative system produces a human-readable story during pipeline execution.
 * Each handler (Pipeline.executeNode, DeciderHandler, ChildrenExecutor, LoopHandler,
 * SubflowExecutor) calls specific narrative methods at traversal time. These tests
 * verify those calls are made correctly using a mock INarrativeGenerator.
 *
 * MODULES INVOLVED:
 * - Pipeline.executeNode: onStageExecuted, onNext, onBreak, onError
 * - DeciderHandler: onDecision, onError
 * - ChildrenExecutor: onFork, onSelected
 * - LoopHandler: onLoop
 * - SubflowExecutor: onSubflowEntry, onSubflowExit
 *
 * _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 5.2, 6.1, 6.2, 7.1, 7.2, 10.1, 10.2_
 */

import { DeciderHandler, RunStageFn, ExecuteNodeFn as DeciderExecuteNodeFn, CallExtractorFn, GetStagePathFn } from '../../../../../src/core/executor/handlers/DeciderHandler';
import { ChildrenExecutor, ExecuteNodeFn as ChildrenExecuteNodeFn } from '../../../../../src/core/executor/handlers/ChildrenExecutor';
import { LoopHandler, ExecuteNodeFn as LoopExecuteNodeFn } from '../../../../../src/core/executor/handlers/LoopHandler';
import { NodeResolver } from '../../../../../src/core/executor/handlers/NodeResolver';
import { PipelineContext } from '../../../../../src/core/executor/types';
import { StageNode, Decider } from '../../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../../src/core/memory/PipelineRuntime';
import { INarrativeGenerator } from '../../../../../src/core/executor/narrative/types';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock INarrativeGenerator with jest.fn() for every method.
 *
 * WHY: Allows verifying that handlers call the correct narrative methods
 * with the correct arguments, without producing actual sentences.
 */
function createMockNarrativeGenerator(): jest.Mocked<INarrativeGenerator> {
  return {
    onStageExecuted: jest.fn(),
    onNext: jest.fn(),
    onDecision: jest.fn(),
    onFork: jest.fn(),
    onSelected: jest.fn(),
    onSubflowEntry: jest.fn(),
    onSubflowExit: jest.fn(),
    onLoop: jest.fn(),
    onBreak: jest.fn(),
    onError: jest.fn(),
    getSentences: jest.fn().mockReturnValue([]),
  };
}

/**
 * Creates a minimal PipelineContext with a mock narrative generator.
 *
 * WHY: Handlers receive the narrative generator via PipelineContext.
 * This helper wires the mock so tests can verify calls.
 */
function createTestContext<TOut = any, TScope = any>(
  mockNarrative: jest.Mocked<INarrativeGenerator>,
): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: (_context, stageName) => ({ stageName } as unknown as TScope),
    scopeProtectionMode: 'off',
    narrativeGenerator: mockNarrative,
  };
}

/**
 * Creates a NodeResolver with a mocked getNextNode that returns the given child.
 */
function createNodeResolverWithDeciderResult<TOut = any, TScope = any>(
  ctx: PipelineContext<TOut, TScope>,
  deciderResult: StageNode<TOut, TScope>,
): NodeResolver<TOut, TScope> {
  const resolver = new NodeResolver(ctx);
  resolver.getNextNode = jest.fn().mockResolvedValue(deciderResult);
  return resolver;
}

// No-op callbacks shared across tests
const noopRunStage: RunStageFn = async (_node, fn, _ctx, _breakFn) => {
  return fn({} as any, () => {}, undefined);
};
const noopExecuteNode: DeciderExecuteNodeFn = async () => 'executed';
const noopCallExtractor: CallExtractorFn = () => {};
const noopGetStagePath: GetStagePathFn = () => 'test.path';


// ─────────────────────────────────────────────────────────────────────────────
// DeciderHandler Narrative Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('DeciderHandler narrative integration', () => {
  /**
   * BEHAVIOR: Legacy decider calls onDecision after selecting a branch
   * WHY: Decision points are the most valuable narrative events for LLM context
   */
  describe('handle() (legacy decider)', () => {
    /**
     * VERIFIES: onDecision is called with correct branch name and no rationale
     * when decider selects a branch without rationale available.
     */
    it('should call onDecision with chosen branch name', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const childNode: StageNode = { name: 'grantAccess', id: 'grant', displayName: 'Grant Full Access' };
      const ctx = createTestContext(mockNarrative);
      const resolver = createNodeResolverWithDeciderResult(ctx, childNode);
      const handler = new DeciderHandler(ctx, resolver);

      const deciderNode: StageNode = {
        name: 'roleCheck',
        id: 'role-check',
        displayName: 'Role Check',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };

      await handler.handle(
        deciderNode, undefined, ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false }, 'main',
        noopRunStage, noopExecuteNode, noopCallExtractor, noopGetStagePath,
      );

      expect(mockNarrative.onDecision).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onDecision).toHaveBeenCalledWith(
        'roleCheck',        // deciderName
        'grantAccess',      // chosenBranch (name)
        'Grant Full Access', // chosenDisplayName
        undefined,           // rationale (none set)
      );
    });

    /**
     * VERIFIES: onDecision includes rationale when available in StageMetadata.
     * _Requirements: 4.1_
     */
    it('should call onDecision with rationale when available', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const childNode: StageNode = { name: 'adminPath', id: 'admin', displayName: 'Admin Path' };
      const ctx = createTestContext(mockNarrative);
      const resolver = createNodeResolverWithDeciderResult(ctx, childNode);
      const handler = new DeciderHandler(ctx, resolver);

      const deciderNode: StageNode = {
        name: 'roleDecider',
        id: 'role-decider',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      // Set rationale in StageMetadata where DeciderHandler reads it
      stageContext.debug.setLog('deciderRationale', 'user role equals admin');

      await handler.handle(
        deciderNode, undefined, stageContext,
        { shouldBreak: false }, 'main',
        noopRunStage, noopExecuteNode, noopCallExtractor, noopGetStagePath,
      );

      expect(mockNarrative.onDecision).toHaveBeenCalledWith(
        'roleDecider',
        'adminPath',
        'Admin Path',
        'user role equals admin',
      );
    });

    /**
     * VERIFIES: onError is called when the stage function throws.
     * _Requirements: 10.2_
     */
    it('should call onError when stage throws', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const childNode: StageNode = { name: 'childA', id: 'child-a' };
      const ctx = createTestContext(mockNarrative);
      const resolver = createNodeResolverWithDeciderResult(ctx, childNode);
      const handler = new DeciderHandler(ctx, resolver);

      const deciderNode: StageNode = {
        name: 'failingDecider',
        id: 'failing',
        displayName: 'Failing Decider',
        fn: () => 'result',
        nextNodeDecider: (() => childNode) as Decider,
        children: [childNode],
      };

      const throwingRunStage: RunStageFn = async () => {
        throw new Error('Decider stage failed');
      };

      await expect(
        handler.handle(
          deciderNode, (() => {}) as any, ctx.pipelineRuntime.rootStageContext,
          { shouldBreak: false }, 'main',
          throwingRunStage, noopExecuteNode, noopCallExtractor, noopGetStagePath,
        ),
      ).rejects.toThrow('Decider stage failed');

      expect(mockNarrative.onError).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onError).toHaveBeenCalledWith(
        'failingDecider',
        expect.stringContaining('Decider stage failed'),
        'Failing Decider',
      );
      // onDecision should NOT be called when stage errors
      expect(mockNarrative.onDecision).not.toHaveBeenCalled();
    });
  });

  /**
   * BEHAVIOR: Scope-based decider calls onDecision after selecting a branch
   * WHY: Scope-based deciders are first-class decisions that should appear in narrative
   */
  describe('handleScopeBased()', () => {
    /**
     * VERIFIES: onDecision is called for scope-based decider with branch name.
     * _Requirements: 4.2_
     */
    it('should call onDecision with chosen branch', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const childNode: StageNode = { name: 'branchA', id: 'branch-a', displayName: 'Branch A' };
      const ctx = createTestContext(mockNarrative);
      const resolver = new NodeResolver(ctx);
      const handler = new DeciderHandler(ctx, resolver);

      const deciderNode: StageNode = {
        name: 'scopeDecider',
        id: 'scope-decider',
        deciderFn: true,
        fn: () => 'branch-a',
        children: [childNode],
      };

      const runStage: RunStageFn = async () => 'branch-a';

      await handler.handleScopeBased(
        deciderNode, (() => 'branch-a') as any, ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false }, 'main',
        runStage, noopExecuteNode, noopCallExtractor, noopGetStagePath,
      );

      expect(mockNarrative.onDecision).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onDecision).toHaveBeenCalledWith(
        'scopeDecider',
        'branchA',
        'Branch A',
        undefined, // no rationale set
      );
    });

    /**
     * VERIFIES: onError is called when scope-based decider throws.
     * _Requirements: 10.2_
     */
    it('should call onError when scope-based decider throws', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const childNode: StageNode = { name: 'branchA', id: 'branch-a' };
      const ctx = createTestContext(mockNarrative);
      const resolver = new NodeResolver(ctx);
      const handler = new DeciderHandler(ctx, resolver);

      const deciderNode: StageNode = {
        name: 'failingScopeDecider',
        id: 'failing-scope',
        displayName: 'Failing Scope Decider',
        deciderFn: true,
        fn: () => 'branch-a',
        children: [childNode],
      };

      const throwingRunStage: RunStageFn = async () => {
        throw new Error('Scope decider failed');
      };

      await expect(
        handler.handleScopeBased(
          deciderNode, (() => {}) as any, ctx.pipelineRuntime.rootStageContext,
          { shouldBreak: false }, 'main',
          throwingRunStage, noopExecuteNode, noopCallExtractor, noopGetStagePath,
        ),
      ).rejects.toThrow('Scope decider failed');

      expect(mockNarrative.onError).toHaveBeenCalledWith(
        'failingScopeDecider',
        expect.stringContaining('Scope decider failed'),
        'Failing Scope Decider',
      );
      expect(mockNarrative.onDecision).not.toHaveBeenCalled();
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// ChildrenExecutor Narrative Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('ChildrenExecutor narrative integration', () => {
  /**
   * BEHAVIOR: Fork execution calls onFork with all child names
   * WHY: Captures the fan-out so the reader knows which paths ran concurrently
   */
  describe('executeNodeChildren() — onFork', () => {
    /**
     * VERIFIES: onFork is called with parent stage name and all child names.
     * _Requirements: 5.1_
     */
    it('should call onFork with parent name and child names', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);
      const executeNode: ChildrenExecuteNodeFn = async (node) => `result-${node.id}`;
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'forkStage',
        id: 'fork',
        displayName: 'Fork Stage',
        children: [
          { name: 'memoryProvider', id: 'mem', displayName: 'Memory Provider' },
          { name: 'recoProvider', id: 'reco', displayName: 'Recommendation Provider' },
          { name: 'ctxProvider', id: 'ctx', displayName: 'Context Provider' },
        ],
      };

      await executor.executeNodeChildren(parentNode, ctx.pipelineRuntime.rootStageContext);

      expect(mockNarrative.onFork).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onFork).toHaveBeenCalledWith(
        'Fork Stage', // uses displayName
        ['Memory Provider', 'Recommendation Provider', 'Context Provider'],
      );
    });

    /**
     * VERIFIES: onFork falls back to stage name when no displayName.
     */
    it('should fall back to name when displayName is not set', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);
      const executeNode: ChildrenExecuteNodeFn = async (node) => `result-${node.id}`;
      const executor = new ChildrenExecutor(ctx, executeNode);

      const parentNode: StageNode = {
        name: 'forkStage',
        id: 'fork',
        children: [
          { name: 'childA', id: 'a' },
          { name: 'childB', id: 'b' },
        ],
      };

      await executor.executeNodeChildren(parentNode, ctx.pipelineRuntime.rootStageContext);

      expect(mockNarrative.onFork).toHaveBeenCalledWith(
        'forkStage',
        ['childA', 'childB'],
      );
    });
  });

  /**
   * BEHAVIOR: Selector execution calls onSelected with selected child names and total count
   * WHY: Captures which children were selected and how many were available
   */
  describe('executeSelectedChildren() — onSelected', () => {
    /**
     * VERIFIES: onSelected is called with selected names and total count.
     * _Requirements: 5.2_
     */
    it('should call onSelected with selected names and total count', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);
      const executeNode: ChildrenExecuteNodeFn = async (node) => `result-${node.id}`;
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'providerA', id: 'a', displayName: 'Provider A' },
        { name: 'providerB', id: 'b', displayName: 'Provider B' },
        { name: 'providerC', id: 'c', displayName: 'Provider C' },
        { name: 'providerD', id: 'd', displayName: 'Provider D' },
      ];

      const selector = () => ['a', 'c'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;

      await executor.executeSelectedChildren(selector, children, {}, parentContext, 'test');

      expect(mockNarrative.onSelected).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onSelected).toHaveBeenCalledWith(
        expect.any(String),     // parentStage (context.stageName)
        ['Provider A', 'Provider C'], // selectedNames (displayNames)
        4,                       // totalCount
      );
    });

    /**
     * VERIFIES: onSelected uses stage name when no displayName.
     */
    it('should fall back to name when displayName is not set', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);
      const executeNode: ChildrenExecuteNodeFn = async (node) => `result-${node.id}`;
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'childA', id: 'a' },
        { name: 'childB', id: 'b' },
      ];

      const selector = () => ['a'];
      const parentContext = ctx.pipelineRuntime.rootStageContext;

      await executor.executeSelectedChildren(selector, children, {}, parentContext, 'test');

      expect(mockNarrative.onSelected).toHaveBeenCalledWith(
        expect.any(String),
        ['childA'],
        2,
      );
    });

    /**
     * VERIFIES: onSelected is NOT called when selector returns empty array.
     * EDGE CASE: Empty selection skips children entirely.
     */
    it('should not call onSelected when selector returns empty array', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);
      const executeNode: ChildrenExecuteNodeFn = async () => 'result';
      const executor = new ChildrenExecutor(ctx, executeNode);

      const children: StageNode[] = [
        { name: 'childA', id: 'a' },
      ];

      const selector = () => [] as string[];
      const parentContext = ctx.pipelineRuntime.rootStageContext;

      await executor.executeSelectedChildren(selector, children, {}, parentContext, 'test');

      expect(mockNarrative.onSelected).not.toHaveBeenCalled();
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// LoopHandler Narrative Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('LoopHandler narrative integration', () => {
  /**
   * BEHAVIOR: Loop-back calls onLoop with target stage and iteration number
   * WHY: Captures repeated execution so the reader can track iteration counts
   */
  describe('handleStringReference() — onLoop', () => {
    /**
     * VERIFIES: onLoop is called with target name, displayName, and 1-based iteration.
     * _Requirements: 6.1, 6.2_
     */
    it('should call onLoop with target stage and iteration number', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      // Build a tree with a target node that can be found by NodeResolver
      const targetNode: StageNode = { name: 'askLLM', id: 'ask-llm', displayName: 'Ask LLM' };
      ctx.root = {
        name: 'root',
        id: 'root',
        next: targetNode,
      };

      const resolver = new NodeResolver(ctx);
      const handler = new LoopHandler(ctx, resolver);

      const currentNode: StageNode = { name: 'evaluate', id: 'evaluate' };
      const executeNode: LoopExecuteNodeFn = async () => 'loop-result';

      await handler.handle(
        'ask-llm', // string reference to target
        currentNode,
        ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false },
        'main',
        executeNode,
      );

      expect(mockNarrative.onLoop).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onLoop).toHaveBeenCalledWith(
        'askLLM',     // targetStage name
        'Ask LLM',    // targetDisplayName
        1,            // iteration (1-based, first loop-back)
      );
    });

    /**
     * VERIFIES: onLoop increments iteration on subsequent calls.
     * _Requirements: 6.2_
     */
    it('should increment iteration number on subsequent loops', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      const targetNode: StageNode = { name: 'retry', id: 'retry-node', displayName: 'Retry Step' };
      ctx.root = { name: 'root', id: 'root', next: targetNode };

      const resolver = new NodeResolver(ctx);
      const handler = new LoopHandler(ctx, resolver);

      const currentNode: StageNode = { name: 'check', id: 'check' };
      const executeNode: LoopExecuteNodeFn = async () => 'result';

      // First loop
      await handler.handle('retry-node', currentNode, ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false }, 'main', executeNode);

      // Second loop
      await handler.handle('retry-node', currentNode, ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false }, 'main', executeNode);

      expect(mockNarrative.onLoop).toHaveBeenCalledTimes(2);
      expect(mockNarrative.onLoop).toHaveBeenNthCalledWith(1, 'retry', 'Retry Step', 1);
      expect(mockNarrative.onLoop).toHaveBeenNthCalledWith(2, 'retry', 'Retry Step', 2);
    });
  });

  /**
   * BEHAVIOR: Node reference loop-back also calls onLoop
   * WHY: Both string and node reference patterns should produce narrative
   */
  describe('handleNodeReference() — onLoop', () => {
    /**
     * VERIFIES: onLoop is called when dynamicNext is a StageNode reference (no fn).
     * _Requirements: 6.1_
     */
    it('should call onLoop for node reference loop-back', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      const targetNode: StageNode = { name: 'processItem', id: 'process', displayName: 'Process Item' };
      ctx.root = { name: 'root', id: 'root', next: targetNode };

      const resolver = new NodeResolver(ctx);
      const handler = new LoopHandler(ctx, resolver);

      const currentNode: StageNode = { name: 'validate', id: 'validate' };
      // StageNode reference without fn — triggers handleNodeReference
      const dynamicNext: StageNode = { name: 'processItem', id: 'process' };
      const executeNode: LoopExecuteNodeFn = async () => 'result';

      await handler.handle(dynamicNext, currentNode, ctx.pipelineRuntime.rootStageContext,
        { shouldBreak: false }, 'main', executeNode);

      expect(mockNarrative.onLoop).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onLoop).toHaveBeenCalledWith(
        'processItem',
        'Process Item',
        1,
      );
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// SubflowExecutor Narrative Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('SubflowExecutor narrative integration', () => {
  /**
   * BEHAVIOR: Subflow entry/exit calls onSubflowEntry and onSubflowExit
   * WHY: Marks nesting boundaries so the reader can follow nested execution contexts
   */
  describe('executeSubflow() — onSubflowEntry / onSubflowExit', () => {
    // Lazy imports to avoid pulling in heavy SubflowExecutor dependencies at top level
    let SubflowExecutor: typeof import('../../../../../src/core/executor/handlers/SubflowExecutor').SubflowExecutor;
    let NodeResolver: typeof import('../../../../../src/core/executor/handlers/NodeResolver').NodeResolver;
    let SubflowResult: any;

    beforeAll(async () => {
      const subflowMod = await import('../../../../../src/core/executor/handlers/SubflowExecutor');
      SubflowExecutor = subflowMod.SubflowExecutor;
      const resolverMod = await import('../../../../../src/core/executor/handlers/NodeResolver');
      NodeResolver = resolverMod.NodeResolver;
    });

    /**
     * VERIFIES: onSubflowEntry is called with subflow display name on entry,
     * and onSubflowExit is called with the same name on exit.
     * _Requirements: 7.1, 7.2_
     */
    it('should call onSubflowEntry and onSubflowExit with subflow name', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      const subflowNode: StageNode = {
        name: 'llm-core-entry',
        id: 'llm-core-entry-id',
        isSubflowRoot: true,
        subflowId: 'llm-core',
        subflowName: 'LLM Core',
        fn: async () => 'subflow-result',
      };

      const resolver = new NodeResolver(ctx);
      const executeStage = async (_node: any, _fn: any, _ctx: any, _breakFn: any) => 'result';
      const callExtractor = () => {};
      const getStageFn = (node: any) => node.fn;

      const executor = new SubflowExecutor(ctx, resolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;
      const subflowResultsMap = new Map();

      await executor.executeSubflow(
        subflowNode, parentContext, { shouldBreak: false }, 'main', subflowResultsMap,
      );

      expect(mockNarrative.onSubflowEntry).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onSubflowEntry).toHaveBeenCalledWith('LLM Core');

      expect(mockNarrative.onSubflowExit).toHaveBeenCalledTimes(1);
      expect(mockNarrative.onSubflowExit).toHaveBeenCalledWith('LLM Core');
    });

    /**
     * VERIFIES: onSubflowEntry is called before onSubflowExit (correct order).
     */
    it('should call onSubflowEntry before onSubflowExit', async () => {
      const callOrder: string[] = [];
      const mockNarrative = createMockNarrativeGenerator();
      mockNarrative.onSubflowEntry.mockImplementation(() => callOrder.push('entry'));
      mockNarrative.onSubflowExit.mockImplementation(() => callOrder.push('exit'));

      const ctx = createTestContext(mockNarrative);

      const subflowNode: StageNode = {
        name: 'sub-entry',
        id: 'sub-entry-id',
        isSubflowRoot: true,
        subflowId: 'my-subflow',
        subflowName: 'My Subflow',
        fn: async () => 'done',
      };

      const resolver = new NodeResolver(ctx);
      const executeStage = async () => 'result';
      const callExtractor = () => {};
      const getStageFn = (node: any) => node.fn;

      const executor = new SubflowExecutor(ctx, resolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;

      await executor.executeSubflow(
        subflowNode, parentContext, { shouldBreak: false }, 'main', new Map(),
      );

      expect(callOrder).toEqual(['entry', 'exit']);
    });

    /**
     * VERIFIES: onSubflowExit is still called even when subflow throws.
     * EDGE CASE: Error during subflow should not skip the exit narrative.
     * _Requirements: 7.2_
     */
    it('should call onSubflowExit even when subflow errors', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      const subflowNode: StageNode = {
        name: 'error-sub',
        id: 'error-sub-id',
        isSubflowRoot: true,
        subflowId: 'error-subflow',
        subflowName: 'Error Subflow',
        fn: async () => { throw new Error('subflow boom'); },
      };

      const resolver = new NodeResolver(ctx);
      const executeStage = async () => { throw new Error('subflow boom'); };
      const callExtractor = () => {};
      const getStageFn = (node: any) => node.fn;

      const executor = new SubflowExecutor(ctx, resolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;

      await expect(
        executor.executeSubflow(
          subflowNode, parentContext, { shouldBreak: false }, 'main', new Map(),
        ),
      ).rejects.toThrow('subflow boom');

      expect(mockNarrative.onSubflowEntry).toHaveBeenCalledWith('Error Subflow');
      expect(mockNarrative.onSubflowExit).toHaveBeenCalledWith('Error Subflow');
    });

    /**
     * VERIFIES: Falls back to node.name when subflowName is not set.
     */
    it('should fall back to node name when subflowName is not set', async () => {
      const mockNarrative = createMockNarrativeGenerator();
      const ctx = createTestContext(mockNarrative);

      const subflowNode: StageNode = {
        name: 'unnamed-subflow',
        id: 'unnamed-id',
        isSubflowRoot: true,
        subflowId: 'unnamed',
        // subflowName intentionally omitted
        fn: async () => 'result',
      };

      const resolver = new NodeResolver(ctx);
      const executeStage = async () => 'result';
      const callExtractor = () => {};
      const getStageFn = (node: any) => node.fn;

      const executor = new SubflowExecutor(ctx, resolver, executeStage, callExtractor, getStageFn);

      const parentRuntime = new PipelineRuntime('parent');
      const parentContext = parentRuntime.rootStageContext;

      await executor.executeSubflow(
        subflowNode, parentContext, { shouldBreak: false }, 'main', new Map(),
      );

      // Falls back to node.name
      expect(mockNarrative.onSubflowEntry).toHaveBeenCalledWith('unnamed-subflow');
      expect(mockNarrative.onSubflowExit).toHaveBeenCalledWith('unnamed-subflow');
    });
  });
});
