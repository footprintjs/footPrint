import { vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type {
  CallExtractorFn,
  ExecuteNodeFn,
  GetStagePathFn,
  RunStageFn,
} from '../../../../src/lib/engine/handlers/DeciderHandler';
import { DeciderHandler } from '../../../../src/lib/engine/handlers/DeciderHandler';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps } from '../../../../src/lib/engine/types';

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    stageMap: new Map(),
    root: { name: 'root' },
    executionRuntime: {},
    ScopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeContext(overrides: Record<string, any> = {}): any {
  return {
    stageName: 'testStage',
    commit: vi.fn(),
    addError: vi.fn(),
    addFlowDebugMessage: vi.fn(),
    createNext: vi.fn().mockReturnValue({ stageName: 'next' }),
    debug: {
      logContext: {},
      errorContext: {},
      metricContext: {},
      evalContext: {},
      flowMessages: [],
    },
    ...overrides,
  };
}

describe('DeciderHandler', () => {
  const childA: StageNode = { name: 'Child A', id: 'child-a' };
  const childB: StageNode = { name: 'childB', id: 'child-b' };
  const defaultChild: StageNode = { name: 'defaultChild', id: 'default' };

  function makeNode(children: StageNode[], extra: Partial<StageNode> = {}): StageNode {
    return { name: 'deciderStage', id: 'decider', children, ...extra };
  }

  // Shared callback stubs
  const noopRunStage: RunStageFn = async (_node, fn, _ctx, breakFn) => fn({} as any, breakFn, undefined);
  const noopExecuteNode: ExecuteNodeFn = async () => 'executed';
  const noopCallExtractor: CallExtractorFn = () => {};
  const noopGetStagePath: GetStagePathFn = () => 'main.deciderStage';

  describe('handleScopeBased — happy path', () => {
    it('executes stage, commits, resolves child by branchId, and calls executeNode', async () => {
      const deps = makeDeps();
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA, childB]);
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'child-a';

      const result = await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        noopExecuteNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      expect(context.commit).toHaveBeenCalled();
      expect(context.createNext).toHaveBeenCalledWith('main', 'Child A');
      expect(result).toBe('executed');
    });

    it('falls back to default child when branchId does not match', async () => {
      const deps = makeDeps();
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA, defaultChild]);
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'nonexistent-branch';

      await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        noopExecuteNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      // Should resolve to default child
      expect(context.createNext).toHaveBeenCalledWith('main', 'defaultChild');
      // Flow message should mention "fell back to default"
      expect(context.addFlowDebugMessage).toHaveBeenCalledWith(
        'branch',
        expect.stringContaining('fell back to default'),
        expect.objectContaining({ targetStage: 'defaultChild' }),
      );
    });

    it('throws when branchId does not match any child and no default exists', async () => {
      const deps = makeDeps();
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA, childB]);
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'nonexistent-branch';

      await expect(
        handler.handleScopeBased(
          node,
          stageFunc,
          context,
          breakFlag,
          'main',
          noopRunStage,
          noopExecuteNode,
          noopCallExtractor,
          noopGetStagePath,
        ),
      ).rejects.toThrow("doesn't match any child");

      expect(context.addError).toHaveBeenCalledWith('deciderError', expect.stringContaining('nonexistent-branch'));
    });
  });

  describe('handleScopeBased — break flag', () => {
    it('returns branchId early when break flag is set during stage execution', async () => {
      const deps = makeDeps();
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA]);
      const breakFlag = { shouldBreak: false };

      // Stage function triggers break
      const stageFunc = (_scope: any, breakPipeline: () => void) => {
        breakPipeline();
        return 'child-a';
      };

      const executeNode = vi.fn();

      const result = await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        executeNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      expect(result).toBe('child-a');
      // executeNode should NOT be called when break is set
      expect(executeNode).not.toHaveBeenCalled();
      // Logger should log the break
      expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('break condition'));
    });
  });

  describe('handleScopeBased — error propagation', () => {
    it('commits, calls extractor, logs error, calls narrativeGenerator.onError, and rethrows', async () => {
      const narrativeGenerator = {
        ...new NullControlFlowNarrativeGenerator(),
        onError: vi.fn(),
      };
      const deps = makeDeps({ narrativeGenerator });
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA]);
      const breakFlag = { shouldBreak: false };

      const stageError = new Error('Stage exploded');
      const failingRunStage: RunStageFn = async () => {
        throw stageError;
      };
      const callExtractor = vi.fn();

      await expect(
        handler.handleScopeBased(
          node,
          () => 'whatever',
          context,
          breakFlag,
          'main',
          failingRunStage,
          noopExecuteNode,
          callExtractor,
          noopGetStagePath,
        ),
      ).rejects.toThrow('Stage exploded');

      // Should commit even on error
      expect(context.commit).toHaveBeenCalled();
      // Should call extractor with error info
      expect(callExtractor).toHaveBeenCalledWith(
        node,
        context,
        'main.deciderStage',
        undefined,
        expect.objectContaining({ type: 'stageExecutionError', message: expect.stringContaining('Stage exploded') }),
      );
      // Should log error to context
      expect(context.addError).toHaveBeenCalledWith('stageExecutionError', expect.stringContaining('Stage exploded'));
      // Should log to deps.logger
      expect(deps.logger.error).toHaveBeenCalled();
      // Should call narrative generator onError
      expect(narrativeGenerator.onError).toHaveBeenCalledWith(
        'deciderStage',
        expect.stringContaining('Stage exploded'),
      );
    });
  });

  describe('handleScopeBased — narrative generation', () => {
    it('includes rationale in flow message when deciderRationale is set in debug logs', async () => {
      const narrativeGenerator = {
        ...new NullControlFlowNarrativeGenerator(),
        onDecision: vi.fn(),
      };
      const deps = makeDeps({ narrativeGenerator });
      const handler = new DeciderHandler(deps);
      const context = makeContext({
        debug: {
          logContext: { deciderRationale: 'User is premium' },
          errorContext: {},
          metricContext: {},
          evalContext: {},
          flowMessages: [],
        },
      });
      const node = makeNode([childA]);
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'child-a';

      await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        noopExecuteNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      // Flow debug message should contain "Based on:" with the rationale
      expect(context.addFlowDebugMessage).toHaveBeenCalledWith(
        'branch',
        expect.stringContaining('Based on: User is premium'),
        expect.objectContaining({ rationale: 'User is premium' }),
      );

      // Narrative generator should receive the rationale
      expect(narrativeGenerator.onDecision).toHaveBeenCalledWith(
        'deciderStage',
        'Child A',
        'User is premium',
        undefined,
      );
    });

    it('uses generic message when no rationale is set', async () => {
      const narrativeGenerator = {
        ...new NullControlFlowNarrativeGenerator(),
        onDecision: vi.fn(),
      };
      const deps = makeDeps({ narrativeGenerator });
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA]);
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'child-a';

      await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        noopExecuteNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      expect(context.addFlowDebugMessage).toHaveBeenCalledWith(
        'branch',
        expect.stringContaining("Evaluated scope and returned 'child-a'"),
        expect.objectContaining({ rationale: 'returned branchId: child-a' }),
      );
    });

    it('passes node description to narrativeGenerator.onDecision', async () => {
      const narrativeGenerator = {
        ...new NullControlFlowNarrativeGenerator(),
        onDecision: vi.fn(),
      };
      const deps = makeDeps({ narrativeGenerator });
      const handler = new DeciderHandler(deps);
      const context = makeContext();
      const node = makeNode([childA], { description: 'Decides the route' });
      const breakFlag = { shouldBreak: false };

      const stageFunc = () => 'child-a';

      await handler.handleScopeBased(
        node,
        stageFunc,
        context,
        breakFlag,
        'main',
        noopRunStage,
        noopExecuteNode,
        noopCallExtractor,
        noopGetStagePath,
      );

      expect(narrativeGenerator.onDecision).toHaveBeenCalledWith(
        'deciderStage',
        'Child A',
        undefined,
        'Decides the route',
      );
    });
  });
});
