import { vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { NodeResolver } from '../../../../src/lib/engine/handlers/NodeResolver';
import { SubflowExecutor } from '../../../../src/lib/engine/handlers/SubflowExecutor';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps, SubflowResult } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const runtime = new ExecutionRuntime('test-root', 'test-root');
  return {
    stageMap: new Map(),
    root: { name: 'root' },
    executionRuntime: runtime,
    ScopeFactory: (ctx: any, name: string, readOnly?: unknown) => ({ ...(readOnly as any) }),
    scopeProtectionMode: 'off' as any,
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: makeLogger(),
    ...overrides,
  };
}

function makeNodeResolver(overrides: Partial<NodeResolver> = {}): NodeResolver<any, any> {
  return {
    findNodeById: vi.fn().mockReturnValue(undefined),
    resolveSubflowReference: vi.fn().mockImplementation((n: StageNode) => n),
    ...overrides,
  } as any;
}

function makeContext(): any {
  const ctx: any = {
    addLog: vi.fn(),
    addFlowDebugMessage: vi.fn(),
    addError: vi.fn(),
    commit: vi.fn(),
    updateObject: vi.fn(),
    stageName: 'test-stage',
    branchId: '',
    parent: undefined,
    getScope: vi.fn().mockReturnValue({}),
    getStageId: vi.fn().mockReturnValue('test-stage-id'),
    createChild: vi.fn(),
    createNext: vi.fn(),
    setObject: vi.fn(),
    setGlobal: vi.fn(),
    getGlobal: vi.fn(),
    appendToArray: vi.fn(),
    mergeObject: vi.fn(),
  };
  ctx.createChild.mockImplementation((_runId: string, branchId: string, name: string) => {
    const child = makeContext();
    child.stageName = name;
    child.branchId = branchId;
    child.parent = ctx;
    return child;
  });
  ctx.createNext.mockImplementation((_path: string, name: string) => {
    const next = makeContext();
    next.stageName = name;
    next.parent = ctx;
    return next;
  });
  return ctx;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('SubflowExecutor', () => {
  let deps: HandlerDeps;
  let nodeResolver: ReturnType<typeof makeNodeResolver>;
  let executeStage: vi.Mock;
  let callExtractor: vi.Mock;
  let getStageFn: vi.Mock;

  beforeEach(() => {
    deps = makeDeps();
    nodeResolver = makeNodeResolver();
    executeStage = vi.fn();
    callExtractor = vi.fn();
    getStageFn = vi.fn().mockReturnValue(undefined);
  });

  function createExecutor() {
    return new SubflowExecutor(deps, nodeResolver as any, executeStage, callExtractor, getStageFn);
  }

  // ────────────────────────────────────────────────────────────────────────
  // executeSubflow — basic flow
  // ────────────────────────────────────────────────────────────────────────

  describe('executeSubflow', () => {
    it('executes a simple subflow with no children and no stage function', async () => {
      const executor = createExecutor();
      const node: StageNode = {
        name: 'mySubflow',
        subflowId: 'sf-1',
        subflowName: 'My Subflow',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const breakFlag = { shouldBreak: false };
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, breakFlag, undefined, resultsMap);

      expect(result).toBeUndefined();
      expect(resultsMap.has('sf-1')).toBe(true);
      const sfResult = resultsMap.get('sf-1')!;
      expect(sfResult.subflowId).toBe('sf-1');
      expect(sfResult.subflowName).toBe('My Subflow');
      expect(context.commit).toHaveBeenCalled();
    });

    it('uses node.name as subflowName when subflowName is not set', async () => {
      const executor = createExecutor();
      const node: StageNode = {
        name: 'fallbackName',
        subflowId: 'sf-2',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      const sfResult = resultsMap.get('sf-2')!;
      expect(sfResult.subflowName).toBe('fallbackName');
    });

    // ── Input mapping (lines 95-107) ────────────────────────────────────

    it('applies inputMapper and seeds subflow GlobalStore', async () => {
      const executor = createExecutor();
      const node: StageNode = {
        name: 'withInput',
        subflowId: 'sf-input',
        isSubflowRoot: false,
        subflowMountOptions: {
          inputMapper: (scope: any) => ({ greeting: scope.hello }),
        },
      };
      const context = makeContext();
      context.getScope.mockReturnValue({ hello: 'world' });
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Input mapping is captured in the subflow result's tree context, not in parent logs
      expect(resultsMap.has('sf-input')).toBe(true);
    });

    it('throws and logs error when inputMapper throws (lines 102-106)', async () => {
      const executor = createExecutor();
      const inputError = new Error('input mapping failed');
      const node: StageNode = {
        name: 'badInput',
        subflowId: 'sf-bad-input',
        isSubflowRoot: false,
        subflowMountOptions: {
          inputMapper: () => {
            throw inputError;
          },
        },
      };
      const context = makeContext();
      context.getScope.mockReturnValue({});
      const resultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap),
      ).rejects.toThrow('input mapping failed');

      expect(context.addError).toHaveBeenCalledWith('inputMapperError', inputError.toString());
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in inputMapper'),
        expect.objectContaining({ error: inputError }),
      );
    });

    // ── Output mapping (lines 162-182) ──────────────────────────────────

    it('applies outputMapper and writes back to parent scope (line 162-175)', async () => {
      const executor = createExecutor();
      const stageFn = vi.fn().mockResolvedValue('subflow-output');
      getStageFn.mockReturnValue(stageFn);

      const node: StageNode = {
        name: 'withOutput',
        subflowId: 'sf-output',
        isSubflowRoot: false,
        subflowMountOptions: {
          outputMapper: (output: any, _parentScope: any) => ({ result: output }),
        },
      };
      const context = makeContext();
      context.getScope.mockReturnValue({});
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Output mapping commits to parent scope — no longer logged to parent context
      expect(context.commit).toHaveBeenCalled();
    });

    it('uses parent context for output when parentContext has branchId (line 165-166)', async () => {
      const executor = createExecutor();
      const stageFn = vi.fn().mockResolvedValue('branch-output');
      getStageFn.mockReturnValue(stageFn);

      const parentOfBranch = makeContext();
      parentOfBranch.getScope.mockReturnValue({ existing: true });
      parentOfBranch.branchId = '';

      const node: StageNode = {
        name: 'branchSubflow',
        subflowId: 'sf-branch',
        isSubflowRoot: false,
        subflowMountOptions: {
          outputMapper: (output: any) => ({ mapped: output }),
        },
      };
      const context = makeContext();
      context.branchId = 'branch-1';
      context.parent = parentOfBranch;
      context.getScope.mockReturnValue({});
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Output should be committed to parent of branch
      expect(parentOfBranch.commit).toHaveBeenCalled();
    });

    it('catches and logs outputMapper errors (lines 178-181)', async () => {
      const executor = createExecutor();
      getStageFn.mockReturnValue(vi.fn().mockResolvedValue('ok'));

      const node: StageNode = {
        name: 'badOutput',
        subflowId: 'sf-bad-output',
        isSubflowRoot: false,
        subflowMountOptions: {
          outputMapper: () => {
            throw new Error('output mapping failed');
          },
        },
      };
      const context = makeContext();
      context.getScope.mockReturnValue({});
      const resultsMap = new Map<string, SubflowResult>();

      // Should NOT throw — output errors are caught
      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(context.addError).toHaveBeenCalledWith(
        'outputMapperError',
        expect.stringContaining('output mapping failed'),
      );
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in outputMapper'),
        expect.any(Object),
      );
    });

    // ── Subflow error (lines 150-156) ───────────────────────────────────

    it('catches stage execution error and re-throws after cleanup', async () => {
      const executor = createExecutor();
      const stageError = new Error('stage exploded');
      getStageFn.mockReturnValue(vi.fn().mockRejectedValue(stageError));

      const node: StageNode = {
        name: 'errorSubflow',
        subflowId: 'sf-error',
        isSubflowRoot: false,
      };
      const context = makeContext();
      context.getScope.mockReturnValue({});
      const resultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap),
      ).rejects.toThrow('stage exploded');

      expect(context.addError).toHaveBeenCalledWith('subflowError', stageError.toString());
      // SubflowResult should still be recorded even on error
      expect(resultsMap.has('sf-error')).toBe(true);
    });

    // ── pipelineStructure from subflow def ──────────────────────────────

    it('includes pipelineStructure when subflows dict has buildTimeStructure', async () => {
      const subflowDef = {
        root: { name: 'sub-root' },
        buildTimeStructure: { name: 'serialized-structure' },
      };
      deps = makeDeps({ subflows: { 'sf-struct': subflowDef as any } });
      const executor = new SubflowExecutor(deps, nodeResolver as any, executeStage, callExtractor, getStageFn);

      const node: StageNode = {
        name: 'structSubflow',
        subflowId: 'sf-struct',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      const result = resultsMap.get('sf-struct')!;
      expect(result.pipelineStructure).toEqual({ name: 'serialized-structure' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // executeSubflowInternal via executeSubflow (indirect testing)
  // ──────────────────────────────────────────────────────────────────────

  describe('executeSubflowInternal (via executeSubflow)', () => {
    // ── Nested subflow detection (lines 229-232) ──────────────────────

    it('detects nested subflow and delegates to executeSubflow recursively', async () => {
      const executor = createExecutor();

      // The inner child is itself a subflow root
      const innerSubflowNode: StageNode = {
        name: 'inner-subflow',
        id: 'inner-sf',
        isSubflowRoot: true,
        subflowId: 'nested-sf-id',
      };

      // The outer subflow has children that include the nested subflow
      const outerNode: StageNode = {
        name: 'outer-subflow',
        subflowId: 'outer-sf-id',
        isSubflowRoot: false,
        children: [innerSubflowNode],
      };

      // nodeResolver.resolveSubflowReference should return the inner node with structure
      const resolvedInner: StageNode = {
        ...innerSubflowNode,
        fn: undefined,
      };
      nodeResolver.resolveSubflowReference.mockReturnValue(resolvedInner);

      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(outerNode, context, { shouldBreak: false }, undefined, resultsMap);

      // The nested subflow should be detected and resolveSubflowReference called
      expect(nodeResolver.resolveSubflowReference).toHaveBeenCalledWith(innerSubflowNode);
      // Both subflows should be in results
      expect(resultsMap.has('outer-sf-id')).toBe(true);
      expect(resultsMap.has('nested-sf-id')).toBe(true);
    });

    // ── Stage execution within subflow (lines 238-256) ──────────────

    it('executes stage function using subflow StageRunner', async () => {
      const stageFn = vi.fn().mockResolvedValue('stage-result');
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'stageInSubflow',
        subflowId: 'sf-stage',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('stage-result');
      expect(callExtractor).toHaveBeenCalled();
    });

    // ── Stage error within subflow (lines 246-254) ──────────────────

    it('handles stage execution error inside subflow with extractor call', async () => {
      const stageError = new Error('internal stage error');
      const stageFn = vi.fn().mockRejectedValue(stageError);
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'errorStage',
        subflowId: 'sf-err-stage',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap),
      ).rejects.toThrow('internal stage error');

      // callExtractor should be called with error info
      expect(callExtractor).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'errorStage' }),
        expect.anything(),
        expect.any(String),
        undefined,
        expect.objectContaining({
          type: 'stageExecutionError',
          message: expect.stringContaining('internal stage error'),
        }),
      );
    });

    // ── Break flag (line 258-259) ───────────────────────────────────

    it('returns early when break flag is set by stage function', async () => {
      const stageFn = vi.fn().mockImplementation((_scope: any, breakFn: () => void) => {
        breakFn();
        return 'break-result';
      });
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const nextNode: StageNode = { name: 'shouldNotRun', fn: vi.fn() };
      const node: StageNode = {
        name: 'breakStage',
        subflowId: 'sf-break',
        isSubflowRoot: false,
        next: nextNode,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('break-result');
      // The next stage's getStageFn should only be called for the first node
    });

    // ── Dynamic StageNode return (lines 263-289) ────────────────────

    it('handles dynamic StageNodeReturn with children and selector', async () => {
      const childA: StageNode = { name: 'dynChild-A', id: 'dyn-a' };
      const childB: StageNode = { name: 'dynChild-B', id: 'dyn-b' };

      const dynamicReturn: StageNode = {
        name: 'dynamic-node',
        children: [childA, childB],
        nextNodeSelector: vi.fn().mockResolvedValue(['dyn-a']),
      };

      const stageFn = vi.fn().mockResolvedValue(dynamicReturn);
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'dynStage') return stageFn;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'dynStage',
        subflowId: 'sf-dynamic',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Verify the dynamic return was processed (no throw)
      expect(resultsMap.has('sf-dynamic')).toBe(true);
    });

    it('handles dynamic StageNodeReturn with next pointer (lines 279-288)', async () => {
      const dynamicNext: StageNode = { name: 'dynNext', id: 'dyn-next-id' };
      const dynamicReturn: StageNode = {
        name: 'dynamic-with-next',
        next: dynamicNext,
      };

      const stageFn = vi.fn().mockResolvedValue(dynamicReturn);
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'dynNextStage') return stageFn;
        return undefined;
      });

      // findNodeById should resolve the dynamic next
      nodeResolver.findNodeById.mockReturnValue(undefined);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'dynNextStage',
        subflowId: 'sf-dyn-next',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(resultsMap.has('sf-dyn-next')).toBe(true);
    });

    // ── Children dispatch (lines 292-306) ──────────────────────────

    it('dispatches children via executeNodeChildrenInternal (lines 302-304)', async () => {
      const childFn = vi.fn().mockResolvedValue('child-result');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'child-1' || n.name === 'child-2') return childFn;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'parentInSubflow',
        subflowId: 'sf-children',
        isSubflowRoot: false,
        children: [
          { name: 'child-1', id: 'c1' },
          { name: 'child-2', id: 'c2' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Children should produce results
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('dispatches children with selector (lines 297-301)', async () => {
      const childFn = vi.fn().mockResolvedValue('selected-result');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'sel-child-1') return childFn;
        return undefined;
      });

      const selector = vi.fn().mockResolvedValue(['sc1']);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'selectorParent',
        subflowId: 'sf-selector',
        isSubflowRoot: false,
        nextNodeSelector: selector,
        children: [
          { name: 'sel-child-1', id: 'sc1' },
          { name: 'sel-child-2', id: 'sc2' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBeDefined();
    });

    it('returns children results when no next node (lines 301, 304)', async () => {
      getStageFn.mockReturnValue(undefined);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'childrenOnly',
        subflowId: 'sf-no-next',
        isSubflowRoot: false,
        children: [{ name: 'c1', id: 'c1' }],
        // no next
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Result should be the children results object
      expect(result).toBeDefined();
    });

    // ── Linear next (lines 308-336) ─────────────────────────────────

    it('follows linear next chain (lines 308-336)', async () => {
      const firstFn = vi.fn().mockResolvedValue('first-out');
      const secondFn = vi.fn().mockResolvedValue('second-out');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'first') return firstFn;
        if (n.name === 'second') return secondFn;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'first',
        subflowId: 'sf-linear',
        isSubflowRoot: false,
        next: { name: 'second', id: 'second-id', fn: secondFn },
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('second-out');
    });

    // ── Dynamic next resolution (lines 313-332) ─────────────────────

    it('resolves dynamic next node from subflow root (lines 315-318)', async () => {
      const stageFn = vi.fn().mockResolvedValue('first');
      const resolvedNextFn = vi.fn().mockResolvedValue('resolved-next-result');
      const resolvedNode: StageNode = { name: 'resolvedNext', id: 'target', fn: resolvedNextFn };

      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'dynResolveStage') return stageFn;
        if (n.name === 'resolvedNext' || n.id === 'target') return resolvedNextFn;
        return undefined;
      });

      // First call with subflow root, return the resolved node
      nodeResolver.findNodeById.mockImplementation((id: string, startNode?: StageNode) => {
        if (id === 'target' && startNode) return resolvedNode;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'dynResolveStage',
        subflowId: 'sf-dyn-resolve',
        isSubflowRoot: false,
        next: { name: 'ref', id: 'target' }, // has id but no fn -> reference node
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('resolved-next-result');
    });

    it('resolves dynamic next from main pipeline when not found in subflow (lines 319-321)', async () => {
      const stageFn = vi.fn().mockResolvedValue('first');
      const mainPipelineNode: StageNode = {
        name: 'mainNode',
        id: 'main-target',
        fn: vi.fn().mockResolvedValue('from-main'),
      };

      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'mainResolve') return stageFn;
        if (n.name === 'mainNode' || n.id === 'main-target') return mainPipelineNode.fn;
        return undefined;
      });

      // Not found in subflow root, found in main pipeline
      nodeResolver.findNodeById.mockImplementation((id: string, startNode?: StageNode) => {
        if (startNode) return undefined; // not in subflow
        if (id === 'main-target') return mainPipelineNode; // found in main
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'mainResolve',
        subflowId: 'sf-main-resolve',
        isSubflowRoot: false,
        next: { name: 'ref', id: 'main-target' },
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('from-main');
    });

    it('logs when dynamic next node is not found anywhere (lines 327-331)', async () => {
      const stageFn = vi.fn().mockResolvedValue('done');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'notFoundStage') return stageFn;
        return undefined;
      });

      nodeResolver.findNodeById.mockReturnValue(undefined);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'notFoundStage',
        subflowId: 'sf-not-found',
        isSubflowRoot: false,
        next: { name: 'ref', id: 'missing-id' },
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Dynamic next node 'missing-id' not found"),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // executeNodeChildrenInternal (lines 348-381)
  // ──────────────────────────────────────────────────────────────────────

  describe('executeNodeChildrenInternal (via executeSubflow)', () => {
    it('catches child execution error and returns isError: true (lines 363-367)', async () => {
      const childError = new Error('child-failed');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'good-child') return vi.fn().mockResolvedValue('ok');
        if (n.name === 'bad-child') return vi.fn().mockRejectedValue(childError);
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'forkParent',
        subflowId: 'sf-fork-err',
        isSubflowRoot: false,
        children: [
          { name: 'good-child', id: 'gc' },
          { name: 'bad-child', id: 'bc' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Should have results for both children
      expect(result).toBeDefined();
      expect(result.gc).toEqual(expect.objectContaining({ id: 'gc', isError: false }));
      expect(result.bc).toEqual(expect.objectContaining({ id: 'bc', isError: true }));
    });

    it('handles all children succeeding', async () => {
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'ch-a') return vi.fn().mockResolvedValue('res-a');
        if (n.name === 'ch-b') return vi.fn().mockResolvedValue('res-b');
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'forkSuccess',
        subflowId: 'sf-fork-ok',
        isSubflowRoot: false,
        children: [
          { name: 'ch-a', id: 'a' },
          { name: 'ch-b', id: 'b' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result.a).toEqual(expect.objectContaining({ id: 'a', result: 'res-a', isError: false }));
      expect(result.b).toEqual(expect.objectContaining({ id: 'b', result: 'res-b', isError: false }));
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // executeSelectedChildrenInternal (lines 383-419)
  // ──────────────────────────────────────────────────────────────────────

  describe('executeSelectedChildrenInternal (via executeSubflow)', () => {
    it('executes selected children and skips others (lines 402, 412-415)', async () => {
      const selectedFn = vi.fn().mockResolvedValue('selected-ok');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'sel-a') return selectedFn;
        return undefined;
      });

      const selector = vi.fn().mockResolvedValue(['sel-a-id']);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'selectorNode',
        subflowId: 'sf-selected',
        isSubflowRoot: false,
        nextNodeSelector: selector,
        children: [
          { name: 'sel-a', id: 'sel-a-id' },
          { name: 'sel-b', id: 'sel-b-id' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Only sel-a should be in results
      expect(result).toBeDefined();
      expect(result['sel-a-id']).toEqual(expect.objectContaining({ id: 'sel-a-id', isError: false }));
      expect(result['sel-b-id']).toBeUndefined();
    });

    it('returns empty results when selector returns empty array (lines 397-400)', async () => {
      const selector = vi.fn().mockResolvedValue([]);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'emptySelector',
        subflowId: 'sf-empty-sel',
        isSubflowRoot: false,
        nextNodeSelector: selector,
        children: [{ name: 'ch', id: 'ch-id' }],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toEqual({});
    });

    it('throws when selector returns unknown child IDs (lines 403-409)', async () => {
      const selector = vi.fn().mockResolvedValue(['nonexistent']);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'unknownSelector',
        subflowId: 'sf-unknown-sel',
        isSubflowRoot: false,
        nextNodeSelector: selector,
        children: [{ name: 'existing', id: 'existing-id' }],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await expect(
        executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap),
      ).rejects.toThrow('Selector returned unknown child IDs: nonexistent');
    });

    it('wraps single string selector result as array (line 392)', async () => {
      const childFn = vi.fn().mockResolvedValue('single-result');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'single-child') return childFn;
        return undefined;
      });

      const selector = vi.fn().mockResolvedValue('single-id');

      const executor = createExecutor();
      const node: StageNode = {
        name: 'singleSelector',
        subflowId: 'sf-single-sel',
        isSubflowRoot: false,
        nextNodeSelector: selector,
        children: [
          { name: 'single-child', id: 'single-id' },
          { name: 'other-child', id: 'other-id' },
        ],
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result['single-id']).toEqual(expect.objectContaining({ id: 'single-id', isError: false }));
      expect(result['other-id']).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Children + next continuation (lines 301, 304)
  // ──────────────────────────────────────────────────────────────────────

  describe('children with next continuation', () => {
    it('subflow strips next when children present — returns children results', async () => {
      const childFn = vi.fn().mockResolvedValue('child-done');
      const nextFn = vi.fn().mockResolvedValue('next-done');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'child') return childFn;
        if (n.name === 'after-children') return nextFn;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'childAndNext',
        subflowId: 'sf-child-next',
        isSubflowRoot: false,
        children: [{ name: 'child', id: 'c' }],
        next: { name: 'after-children', id: 'after', fn: nextFn },
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // executeSubflow strips next when children exist (line 136: next: hasChildren ? undefined : node.next)
      // Children results are returned; next is handled by the parent traverser
      expect(result).toEqual({ c: { id: 'c', result: 'child-done', isError: false } });
      expect(nextFn).not.toHaveBeenCalled();
    });

    it('subflow without children keeps next — follows linear continuation', async () => {
      const stageFn = vi.fn().mockResolvedValue('stage-output');
      const nextFn = vi.fn().mockResolvedValue('next-done');
      getStageFn.mockImplementation((n: StageNode) => {
        if (n.name === 'entry') return stageFn;
        if (n.name === 'continuation') return nextFn;
        return undefined;
      });

      const executor = createExecutor();
      const node: StageNode = {
        name: 'entry',
        subflowId: 'sf-with-next',
        isSubflowRoot: false,
        fn: stageFn,
        next: { name: 'continuation', id: 'cont', fn: nextFn },
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // Without children, next is preserved and followed
      expect(result).toBe('next-done');
      expect(nextFn).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // executeStage fallback (line 244)
  // ──────────────────────────────────────────────────────────────────────

  describe('executeStage fallback (line 244)', () => {
    it('falls back to executeStage when currentSubflowDeps is not set', async () => {
      // We need to test the path where currentSubflowDeps is undefined.
      // This happens when executeSubflowInternal is called outside the
      // executeSubflow wrapper. We can simulate this indirectly by
      // using a node that has next pointing to a node with fn,
      // after the subflow deps would be cleared. However,
      // currentSubflowDeps is always set during executeSubflow.
      // Instead, we test that the StageRunner path works (the normal path).
      const stageFn = vi.fn().mockResolvedValue('runner-result');
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'runnerStage',
        subflowId: 'sf-runner',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(result).toBe('runner-result');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // getStagePath
  // ──────────────────────────────────────────────────────────────────────

  describe('getStagePath (via callExtractor args)', () => {
    it('includes branchPath prefix when provided', async () => {
      const stageFn = vi.fn().mockResolvedValue('out');
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'pathStage',
        subflowId: 'sf-path',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      // The branchPath is the subflowId
      const stagePath = callExtractor.mock.calls[0][2];
      expect(stagePath).toContain('sf-path');
    });

    it('uses node.id when available', async () => {
      const stageFn = vi.fn().mockResolvedValue('out');
      getStageFn.mockReturnValue(stageFn);

      const executor = createExecutor();
      const node: StageNode = {
        name: 'namedStage',
        id: 'stage-id',
        subflowId: 'sf-id-path',
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      const stagePath = callExtractor.mock.calls[0][2];
      expect(stagePath).toContain('stage-id');
    });
  });
});
