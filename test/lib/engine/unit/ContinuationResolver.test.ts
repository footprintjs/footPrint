import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { ContinuationResolver, DEFAULT_MAX_ITERATIONS } from '../../../../src/lib/engine/handlers/ContinuationResolver';
import { NodeResolver } from '../../../../src/lib/engine/handlers/NodeResolver';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { IControlFlowNarrative } from '../../../../src/lib/engine/narrative/types';
import type { HandlerDeps } from '../../../../src/lib/engine/types';

function makeDeps(root: StageNode): HandlerDeps {
  return {
    stageMap: new Map(),
    root,
    executionRuntime: {},
    ScopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
  };
}

function makeContext(): any {
  return {
    addLog: jest.fn(),
    addFlowDebugMessage: jest.fn(),
    createNext: jest.fn().mockReturnValue({ addLog: jest.fn(), addFlowDebugMessage: jest.fn(), createNext: jest.fn() }),
    stageName: 'test',
  };
}

describe('ContinuationResolver', () => {
  describe('getAndIncrementIteration', () => {
    it('returns 0 for first visit, 1 for second', () => {
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));

      expect(resolver.getAndIncrementIteration('nodeA')).toBe(0);
      expect(resolver.getAndIncrementIteration('nodeA')).toBe(1);
      expect(resolver.getAndIncrementIteration('nodeA')).toBe(2);
    });

    it('tracks different nodes independently', () => {
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));

      expect(resolver.getAndIncrementIteration('nodeA')).toBe(0);
      expect(resolver.getAndIncrementIteration('nodeB')).toBe(0);
      expect(resolver.getAndIncrementIteration('nodeA')).toBe(1);
      expect(resolver.getAndIncrementIteration('nodeB')).toBe(1);
    });

    it('throws when max iterations exceeded', () => {
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 3);

      resolver.getAndIncrementIteration('nodeA'); // 0
      resolver.getAndIncrementIteration('nodeA'); // 1
      resolver.getAndIncrementIteration('nodeA'); // 2

      expect(() => resolver.getAndIncrementIteration('nodeA')).toThrow('Maximum loop iterations (3) exceeded');
    });

    it('calls onIterationUpdate callback', () => {
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const onUpdate = jest.fn();
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps), onUpdate);

      resolver.getAndIncrementIteration('nodeA');
      expect(onUpdate).toHaveBeenCalledWith('nodeA', 1);

      resolver.getAndIncrementIteration('nodeA');
      expect(onUpdate).toHaveBeenCalledWith('nodeA', 2);
    });
  });

  describe('getIteratedStageName', () => {
    it('returns base name for iteration 0', () => {
      const root: StageNode = { name: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));

      expect(resolver.getIteratedStageName('askLLM', 0)).toBe('askLLM');
    });

    it('appends iteration number for subsequent visits', () => {
      const root: StageNode = { name: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));

      expect(resolver.getIteratedStageName('askLLM', 1)).toBe('askLLM.1');
      expect(resolver.getIteratedStageName('askLLM', 5)).toBe('askLLM.5');
    });
  });

  describe('resolve', () => {
    it('resolves string reference to existing node', async () => {
      const target: StageNode = { name: 'target', id: 'target-id' };
      const root: StageNode = { name: 'root', next: target };
      const deps = makeDeps(root);
      const nodeResolver = new NodeResolver(deps);
      const resolver = new ContinuationResolver(deps, nodeResolver);
      const context = makeContext();
      const breakFlag = { shouldBreak: false };
      const executeNode = jest.fn().mockResolvedValue('result');

      await resolver.resolve('target-id', root, context, breakFlag, 'path', executeNode);

      expect(executeNode).toHaveBeenCalledWith(target, expect.anything(), breakFlag, 'path');
    });

    it('throws for unknown string reference', async () => {
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));
      const context = makeContext();
      const executeNode = jest.fn();

      await expect(
        resolver.resolve('nonexistent', root, context, { shouldBreak: false }, 'path', executeNode),
      ).rejects.toThrow('dynamicNext target node not found');
    });

    it('executes direct node with fn', async () => {
      const dynamicNode: StageNode = { name: 'dynamic', fn: jest.fn() };
      const root: StageNode = { name: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));
      const context = makeContext();
      const executeNode = jest.fn().mockResolvedValue('ok');

      await resolver.resolve(dynamicNode, root, context, { shouldBreak: false }, 'path', executeNode);

      expect(executeNode).toHaveBeenCalledWith(dynamicNode, expect.anything(), { shouldBreak: false }, 'path');
      expect(context.addLog).toHaveBeenCalledWith('dynamicNextDirect', true);
    });

    it('throws when node reference has no id (handleNodeReference lines 134-137)', async () => {
      const dynamicNode: StageNode = { name: 'refNode' }; // no fn, no id
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));
      const context = makeContext();
      const executeNode = jest.fn();

      await expect(
        resolver.resolve(dynamicNode, root, context, { shouldBreak: false }, 'path', executeNode),
      ).rejects.toThrow('dynamicNext node must have an id when used as reference');
      expect(deps.logger.error).toHaveBeenCalled();
    });

    it('throws when node reference id not found in graph (handleNodeReference lines 141-144)', async () => {
      const dynamicNode: StageNode = { name: 'refNode', id: 'nonexistent-id' }; // no fn, has id but not in graph
      const root: StageNode = { name: 'root', id: 'root' };
      const deps = makeDeps(root);
      const resolver = new ContinuationResolver(deps, new NodeResolver(deps));
      const context = makeContext();
      const executeNode = jest.fn();

      await expect(
        resolver.resolve(dynamicNode, root, context, { shouldBreak: false }, 'path', executeNode),
      ).rejects.toThrow('dynamicNext target node not found: nonexistent-id');
      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  it('DEFAULT_MAX_ITERATIONS is 1000', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1000);
  });
});
