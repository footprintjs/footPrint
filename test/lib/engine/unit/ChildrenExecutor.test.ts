import { ChildrenExecutor } from '../../../../src/lib/engine/handlers/ChildrenExecutor';
import type { HandlerDeps } from '../../../../src/lib/engine/types';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    stageMap: new Map(),
    root: { name: 'root' },
    executionRuntime: {},
    ScopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
    ...overrides,
  };
}

function makeContext(): any {
  const ctx: any = {
    addLog: jest.fn(),
    addFlowDebugMessage: jest.fn(),
    addError: jest.fn(),
    commit: jest.fn(),
    updateObject: jest.fn(),
    stageName: 'test-stage',
    createChild: jest.fn(),
    createNext: jest.fn(),
  };
  // createChild returns a context-like object
  ctx.createChild.mockImplementation(() => ({
    addLog: jest.fn(),
    addFlowDebugMessage: jest.fn(),
    addError: jest.fn(),
    commit: jest.fn(),
    updateObject: jest.fn(),
    stageName: 'child-stage',
    createChild: jest.fn(),
    createNext: jest.fn(),
  }));
  return ctx;
}

describe('ChildrenExecutor', () => {
  describe('executeNodeChildren', () => {
    it('returns empty results for a node with no children', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn();
      const executor = new ChildrenExecutor(deps, executeNode);
      const node: StageNode = { name: 'parent' };
      const context = makeContext();

      const results = await executor.executeNodeChildren(node, context);

      expect(results).toEqual({});
      expect(executeNode).not.toHaveBeenCalled();
    });

    it('returns empty results for a node with empty children array', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn();
      const executor = new ChildrenExecutor(deps, executeNode);
      const node: StageNode = { name: 'parent', children: [] };
      const context = makeContext();

      const results = await executor.executeNodeChildren(node, context);

      expect(results).toEqual({});
      expect(executeNode).not.toHaveBeenCalled();
    });

    it('executes all children in parallel and aggregates results', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn()
        .mockResolvedValueOnce('result-A')
        .mockResolvedValueOnce('result-B');
      const executor = new ChildrenExecutor(deps, executeNode);

      const childA: StageNode = { name: 'childA', id: 'a' };
      const childB: StageNode = { name: 'childB', id: 'b' };
      const node: StageNode = { name: 'parent', children: [childA, childB] };
      const context = makeContext();

      const results = await executor.executeNodeChildren(node, context);

      expect(executeNode).toHaveBeenCalledTimes(2);
      expect(results).toEqual({
        a: { id: 'a', result: 'result-A', isError: false },
        b: { id: 'b', result: 'result-B', isError: false },
      });
    });

    it('catches child errors and marks them with isError: true', async () => {
      const deps = makeDeps();
      const error = new Error('child failed');
      const executeNode = jest.fn()
        .mockResolvedValueOnce('ok')
        .mockRejectedValueOnce(error);
      const executor = new ChildrenExecutor(deps, executeNode);

      const childA: StageNode = { name: 'childA', id: 'a' };
      const childB: StageNode = { name: 'childB', id: 'b' };
      const node: StageNode = { name: 'parent', children: [childA, childB] };
      const context = makeContext();

      const results = await executor.executeNodeChildren(node, context);

      expect(results.a).toEqual({ id: 'a', result: 'ok', isError: false });
      expect(results.b).toEqual({ id: 'b', result: error, isError: true });
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Error for id: b'),
        expect.objectContaining({ error }),
      );
    });

    it('commits child context on success', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn().mockResolvedValue('ok');
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'c1' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      const childCtx = context.createChild.mock.results[0].value;
      expect(childCtx.commit).toHaveBeenCalled();
    });

    it('commits child context on error', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn().mockRejectedValue(new Error('boom'));
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'c1' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      const childCtx = context.createChild.mock.results[0].value;
      expect(childCtx.commit).toHaveBeenCalled();
    });

    it('calls narrativeGenerator.onFork with child display names', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('ok');
      const executor = new ChildrenExecutor(deps, executeNode);

      const childA: StageNode = { name: 'childA', id: 'a', displayName: 'Child A' };
      const childB: StageNode = { name: 'childB', id: 'b' };
      const node: StageNode = { name: 'parent', displayName: 'Parent', children: [childA, childB] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      expect(narrativeGenerator.onFork).toHaveBeenCalledWith('Parent', ['Child A', 'childB']);
    });

    it('uses node.name when displayName is not set for narrative', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('ok');
      const executor = new ChildrenExecutor(deps, executeNode);

      const node: StageNode = { name: 'parent', children: [{ name: 'c1', id: '1' }] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      expect(narrativeGenerator.onFork).toHaveBeenCalledWith('parent', ['c1']);
    });

    it('checks throttling error and updates monitor when throttlingErrorChecker returns true', async () => {
      const throttlingErrorChecker = jest.fn().mockReturnValue(true);
      const deps = makeDeps({ throttlingErrorChecker });
      const error = new Error('rate limited');
      const executeNode = jest.fn().mockRejectedValue(error);
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'c1' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      expect(throttlingErrorChecker).toHaveBeenCalledWith(error);
      const childCtx = context.createChild.mock.results[0].value;
      expect(childCtx.updateObject).toHaveBeenCalledWith(['monitor'], 'isThrottled', true);
    });

    it('does not update monitor when throttlingErrorChecker returns false', async () => {
      const throttlingErrorChecker = jest.fn().mockReturnValue(false);
      const deps = makeDeps({ throttlingErrorChecker });
      const executeNode = jest.fn().mockRejectedValue(new Error('not throttled'));
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'c1' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      const childCtx = context.createChild.mock.results[0].value;
      expect(childCtx.updateObject).not.toHaveBeenCalled();
    });

    describe('break flag propagation', () => {
      it('does not set parentBreakFlag when only some children break', async () => {
        const deps = makeDeps();
        // Simulate: first child sets break, second does not
        const executeNode = jest.fn().mockImplementation((_node, _ctx, breakFlag) => {
          if (_node.name === 'childA') breakFlag.shouldBreak = true;
          return Promise.resolve('ok');
        });
        const executor = new ChildrenExecutor(deps, executeNode);

        const childA: StageNode = { name: 'childA', id: 'a' };
        const childB: StageNode = { name: 'childB', id: 'b' };
        const node: StageNode = { name: 'parent', children: [childA, childB] };
        const context = makeContext();
        const parentBreakFlag = { shouldBreak: false };

        await executor.executeNodeChildren(node, context, parentBreakFlag);

        expect(parentBreakFlag.shouldBreak).toBe(false);
      });

      it('sets parentBreakFlag when ALL children break', async () => {
        const deps = makeDeps();
        const executeNode = jest.fn().mockImplementation((_node, _ctx, breakFlag) => {
          breakFlag.shouldBreak = true;
          return Promise.resolve('ok');
        });
        const executor = new ChildrenExecutor(deps, executeNode);

        const childA: StageNode = { name: 'childA', id: 'a' };
        const childB: StageNode = { name: 'childB', id: 'b' };
        const node: StageNode = { name: 'parent', children: [childA, childB] };
        const context = makeContext();
        const parentBreakFlag = { shouldBreak: false };

        await executor.executeNodeChildren(node, context, parentBreakFlag);

        expect(parentBreakFlag.shouldBreak).toBe(true);
      });

      it('propagates break on error path too', async () => {
        const deps = makeDeps();
        const executeNode = jest.fn().mockImplementation((_node, _ctx, breakFlag) => {
          breakFlag.shouldBreak = true;
          return Promise.reject(new Error('fail'));
        });
        const executor = new ChildrenExecutor(deps, executeNode);

        const child: StageNode = { name: 'child', id: 'c' };
        const node: StageNode = { name: 'parent', children: [child] };
        const context = makeContext();
        const parentBreakFlag = { shouldBreak: false };

        await executor.executeNodeChildren(node, context, parentBreakFlag);

        expect(parentBreakFlag.shouldBreak).toBe(true);
      });
    });

    it('uses branchPath when provided', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn().mockResolvedValue('ok');
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'c1' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context, undefined, 'custom-branch');

      // branchPath passed through to executeNode
      expect(executeNode).toHaveBeenCalledWith(
        child,
        expect.anything(),
        expect.objectContaining({ shouldBreak: false }),
        'custom-branch',
      );
    });

    it('uses child.id as branchPath when branchPath not provided', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn().mockResolvedValue('ok');
      const executor = new ChildrenExecutor(deps, executeNode);

      const child: StageNode = { name: 'child', id: 'my-child-id' };
      const node: StageNode = { name: 'parent', children: [child] };
      const context = makeContext();

      await executor.executeNodeChildren(node, context);

      expect(executeNode).toHaveBeenCalledWith(
        child,
        expect.anything(),
        expect.objectContaining({ shouldBreak: false }),
        'my-child-id',
      );
    });
  });

  describe('executeSelectedChildren', () => {
    it('returns empty when selector returns empty array', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn();
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue([]);
      const children: StageNode[] = [{ name: 'a', id: 'a' }];

      const results = await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(results).toEqual({});
      expect(context.addLog).toHaveBeenCalledWith('skippedAllChildren', true);
      expect(executeNode).not.toHaveBeenCalled();
    });

    it('executes only selected children', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['b']);
      const children: StageNode[] = [
        { name: 'childA', id: 'a' },
        { name: 'childB', id: 'b' },
      ];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      // Only childB should be executed (via the temp node's children)
      expect(executeNode).toHaveBeenCalledTimes(1);
      expect(executeNode).toHaveBeenCalledWith(
        children[1],
        expect.anything(),
        expect.anything(),
        'branch',
      );
    });

    it('wraps single string selector result in array', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue('a');
      const children: StageNode[] = [{ name: 'childA', id: 'a' }];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(context.addLog).toHaveBeenCalledWith('selectedChildIds', ['a']);
      expect(executeNode).toHaveBeenCalledTimes(1);
    });

    it('throws when selector returns unknown child IDs', async () => {
      const deps = makeDeps();
      const executeNode = jest.fn();
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['nonexistent']);
      const children: StageNode[] = [{ name: 'childA', id: 'a' }];

      await expect(
        executor.executeSelectedChildren(selector, children, 'input', context, 'branch'),
      ).rejects.toThrow('Selector returned unknown child IDs: nonexistent');

      expect(context.addError).toHaveBeenCalledWith('selectorError', expect.stringContaining('nonexistent'));
    });

    it('logs skipped child IDs', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['a']);
      const children: StageNode[] = [
        { name: 'childA', id: 'a' },
        { name: 'childB', id: 'b' },
      ];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(context.addLog).toHaveBeenCalledWith('skippedChildIds', ['b']);
    });

    it('calls narrativeGenerator.onSelected with selected display names', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['a']);
      const children: StageNode[] = [
        { name: 'childA', id: 'a', displayName: 'Alpha' },
        { name: 'childB', id: 'b' },
      ];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(narrativeGenerator.onSelected).toHaveBeenCalledWith('test-stage', ['Alpha'], 2);
    });

    it('adds flow debug message with selected info', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['a', 'b']);
      const children: StageNode[] = [
        { name: 'childA', id: 'a' },
        { name: 'childB', id: 'b' },
      ];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(context.addFlowDebugMessage).toHaveBeenCalledWith(
        'selected',
        expect.stringContaining('2 of 2 matched'),
        expect.objectContaining({ count: 2 }),
      );
    });

    it('logs selectorPattern as multi-choice', async () => {
      const narrativeGenerator = {
        onFork: jest.fn(),
        onStageExecuted: jest.fn(),
        onNext: jest.fn(),
        onDecision: jest.fn(),
        onSelected: jest.fn(),
        onSubflowEntry: jest.fn(),
        onSubflowExit: jest.fn(),
        onLoop: jest.fn(),
        onBreak: jest.fn(),
        onError: jest.fn(),
        getSentences: jest.fn().mockReturnValue([]),
      };
      const deps = makeDeps({ narrativeGenerator });
      const executeNode = jest.fn().mockResolvedValue('result');
      const executor = new ChildrenExecutor(deps, executeNode);
      const context = makeContext();

      const selector = jest.fn().mockResolvedValue(['a']);
      const children: StageNode[] = [{ name: 'childA', id: 'a' }];

      await executor.executeSelectedChildren(selector, children, 'input', context, 'branch');

      expect(context.addLog).toHaveBeenCalledWith('selectorPattern', 'multi-choice');
    });
  });
});
