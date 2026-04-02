/**
 * SubflowExecutor unit tests — factory-based architecture.
 *
 * SubflowExecutor is an isolation boundary:
 * - Creates isolated ExecutionRuntime for each subflow
 * - Applies input/output mapping via SubflowInputMapper
 * - Delegates traversal to a factory-created FlowchartTraverser
 * - Tracks subflow results for debugging/visualization
 *
 * It does NOT contain traversal logic — that lives in FlowchartTraverser.
 *
 * Tiers:
 * - unit:     basic flow, input mapping, output mapping, error handling
 * - boundary: no mount options, empty input, empty output, branchId context
 * - scenario: nested subflow results merge, pipelineStructure propagation
 * - property: subflowResult always recorded, commit always called, narrative events always fired
 * - security: input mapper error re-thrown, output mapper error caught, traversal error re-thrown
 */

import { vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { SubflowExecutor } from '../../../../src/lib/engine/handlers/SubflowExecutor';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type {
  HandlerDeps,
  SubflowResult,
  SubflowTraverserFactory,
  SubflowTraverserHandle,
} from '../../../../src/lib/engine/types';
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
    scopeFactory: (ctx: any, name: string, readOnly?: unknown) => ({ ...(readOnly as any) }),
    scopeProtectionMode: 'off' as any,
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: makeLogger(),
    ...overrides,
  };
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

/**
 * Create a mock SubflowTraverserFactory.
 * Returns a factory function and the mock handle for assertions.
 */
function makeFactory(overrides?: {
  executeResult?: any;
  executeError?: Error;
  nestedSubflowResults?: Map<string, SubflowResult>;
}): {
  factory: SubflowTraverserFactory;
  getLastHandle: () => SubflowTraverserHandle<any, any>;
  getLastOptions: () => any;
} {
  let lastHandle: SubflowTraverserHandle<any, any>;
  let lastOptions: any;

  const factory: SubflowTraverserFactory = (opts) => {
    lastOptions = opts;
    const handle: SubflowTraverserHandle<any, any> = {
      execute: overrides?.executeError
        ? vi.fn().mockRejectedValue(overrides.executeError)
        : vi.fn().mockResolvedValue(overrides?.executeResult),
      getSubflowResults: vi.fn().mockReturnValue(overrides?.nestedSubflowResults ?? new Map()),
    };
    lastHandle = handle;
    return handle;
  };

  return {
    factory,
    getLastHandle: () => lastHandle,
    getLastOptions: () => lastOptions,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

// ── Unit Tests ───────────────────────────────────────────────────────────

describe('SubflowExecutor — unit', () => {
  it('executes a simple subflow and records result', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'mySubflow',
      subflowId: 'sf-1',
      subflowName: 'My Subflow',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    expect(resultsMap.has('sf-1')).toBe(true);
    const sfResult = resultsMap.get('sf-1')!;
    expect(sfResult.subflowId).toBe('sf-1');
    expect(sfResult.subflowName).toBe('My Subflow');
    expect(context.commit).toHaveBeenCalled();
  });

  it('uses node.name as subflowName when subflowName is not set', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'fallbackName',
      subflowId: 'sf-2',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    expect(resultsMap.get('sf-2')!.subflowName).toBe('fallbackName');
  });

  it('applies inputMapper and seeds subflow GlobalStore', async () => {
    const deps = makeDeps();
    const { factory, getLastOptions } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

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

    // Factory receives readOnlyContext with the mapped input
    expect(getLastOptions().readOnlyContext).toEqual({ greeting: 'world' });
    expect(resultsMap.has('sf-input')).toBe(true);
  });

  it('applies outputMapper and commits to parent scope', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'withOutput',
      subflowId: 'sf-output',
      isSubflowRoot: false,
      subflowMountOptions: {
        outputMapper: (output: any, _parentScope: any) => ({ result: output?.value ?? 'fallback' }),
      },
    };
    const context = makeContext();
    context.getScope.mockReturnValue({});
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // outputMapper commits to parent context
    expect(context.commit).toHaveBeenCalled();
  });

  it('delegates traversal to factory-created traverser', async () => {
    const deps = makeDeps();
    const { factory, getLastHandle, getLastOptions } = makeFactory({ executeResult: 'traverser-result' });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'delegateTest',
      subflowId: 'sf-delegate',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    const result = await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // Factory was called with correct options
    expect(getLastOptions().root.name).toBe('delegateTest');
    expect(getLastOptions().root.isSubflowRoot).toBe(false);
    expect(getLastOptions().subflowId).toBe('sf-delegate');

    // Traverser handle was executed
    expect(getLastHandle().execute).toHaveBeenCalled();
  });
});

// ── Boundary Tests ───────────────────────────────────────────────────────

describe('SubflowExecutor — boundary', () => {
  it('works with no mount options (no input/output mapping)', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'noOptions',
      subflowId: 'sf-no-opts',
      isSubflowRoot: false,
      // no subflowMountOptions
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    expect(resultsMap.has('sf-no-opts')).toBe(true);
    expect(context.commit).toHaveBeenCalled();
  });

  it('handles empty inputMapper result', async () => {
    const deps = makeDeps();
    const { factory, getLastOptions } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'emptyInput',
      subflowId: 'sf-empty-input',
      isSubflowRoot: false,
      subflowMountOptions: {
        inputMapper: () => ({}),
      },
    };
    const context = makeContext();
    context.getScope.mockReturnValue({});
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // With empty input, readOnlyContext should be empty object
    expect(getLastOptions().readOnlyContext).toEqual({});
  });

  it('uses parent context for output when parentContext has branchId', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const parentOfBranch = makeContext();
    parentOfBranch.getScope.mockReturnValue({ existing: true });
    parentOfBranch.branchId = '';

    const node: StageNode = {
      name: 'branchSubflow',
      subflowId: 'sf-branch',
      isSubflowRoot: false,
      subflowMountOptions: {
        outputMapper: (output: any) => ({ mapped: output?.value }),
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

  it('strips next when node has children (subflow root node setup)', async () => {
    const deps = makeDeps();
    const { factory, getLastOptions } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'withChildren',
      subflowId: 'sf-children',
      isSubflowRoot: false,
      children: [{ name: 'child-1', id: 'c1' }],
      next: { name: 'shouldBeStripped', id: 'stripped' },
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // next should be stripped when children present
    expect(getLastOptions().root.next).toBeUndefined();
    expect(getLastOptions().root.children).toBeDefined();
  });

  it('keeps next when node has no children', async () => {
    const deps = makeDeps();
    const nextNode = { name: 'continuation', id: 'cont' };
    const { factory, getLastOptions } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'noChildren',
      subflowId: 'sf-no-children',
      isSubflowRoot: false,
      next: nextNode,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // next should be preserved when no children
    expect(getLastOptions().root.next).toEqual(nextNode);
  });
});

// ── Scenario Tests ───────────────────────────────────────────────────────

describe('SubflowExecutor — scenario', () => {
  it('merges nested subflow results from traverser handle', async () => {
    const nestedResults = new Map<string, SubflowResult>();
    nestedResults.set('nested-sf', {
      subflowId: 'nested-sf',
      subflowName: 'Nested',
      treeContext: { globalContext: {}, stageContexts: {}, history: [] },
      parentStageId: 'inner',
    });

    const deps = makeDeps();
    const { factory } = makeFactory({ nestedSubflowResults: nestedResults });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'outerSubflow',
      subflowId: 'sf-outer',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // Both outer and nested subflow results should be present
    expect(resultsMap.has('sf-outer')).toBe(true);
    expect(resultsMap.has('nested-sf')).toBe(true);
    expect(resultsMap.get('nested-sf')!.subflowName).toBe('Nested');
  });

  it('includes pipelineStructure when subflows dict has buildTimeStructure', async () => {
    const subflowDef = {
      root: { name: 'sub-root' },
      buildTimeStructure: { name: 'serialized-structure' },
    };
    const deps = makeDeps({ subflows: { 'sf-struct': subflowDef as any } });
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

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

  it('merges nested results even when traversal throws', async () => {
    const nestedResults = new Map<string, SubflowResult>();
    nestedResults.set('partial-sf', {
      subflowId: 'partial-sf',
      subflowName: 'Partial',
      treeContext: { globalContext: {}, stageContexts: {}, history: [] },
      parentStageId: 'inner',
    });

    const deps = makeDeps();
    const { factory } = makeFactory({
      executeError: new Error('traversal failed'),
      nestedSubflowResults: nestedResults,
    });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'errorSubflow',
      subflowId: 'sf-error',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await expect(executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap)).rejects.toThrow(
      'traversal failed',
    );

    // Partial results should still be merged (aids debugging)
    expect(resultsMap.has('partial-sf')).toBe(true);
    expect(resultsMap.has('sf-error')).toBe(true);
  });
});

// ── Property Tests ───────────────────────────────────────────────────────

describe('SubflowExecutor — property', () => {
  it('subflowResult is always recorded regardless of traversal output', async () => {
    for (const result of [undefined, null, '', 0, 'ok', { a: 1 }]) {
      const deps = makeDeps();
      const { factory } = makeFactory({ executeResult: result });
      const executor = new SubflowExecutor(deps, factory);

      const node: StageNode = {
        name: 'propTest',
        subflowId: `sf-prop-${String(result)}`,
        isSubflowRoot: false,
      };
      const context = makeContext();
      const resultsMap = new Map<string, SubflowResult>();

      await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

      expect(resultsMap.has(node.subflowId!)).toBe(true);
      const sfResult = resultsMap.get(node.subflowId!)!;
      expect(sfResult.subflowId).toBe(node.subflowId);
      expect(sfResult.treeContext).toBeDefined();
    }
  });

  it('parentContext.commit is always called on success', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'commitProp',
      subflowId: 'sf-commit',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    expect(context.commit).toHaveBeenCalled();
  });

  it('narrative entry/exit events always fired (even on error)', async () => {
    const narrativeGen = {
      ...new NullControlFlowNarrativeGenerator(),
      onSubflowEntry: vi.fn(),
      onSubflowExit: vi.fn(),
    };
    const deps = makeDeps({ narrativeGenerator: narrativeGen });
    const { factory } = makeFactory({ executeError: new Error('boom') });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'narrativeProp',
      subflowId: 'sf-narrative',
      subflowName: 'NarrativeProp',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await expect(executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap)).rejects.toThrow(
      'boom',
    );

    // Entry event should always fire
    expect(narrativeGen.onSubflowEntry).toHaveBeenCalledWith('NarrativeProp', 'sf-narrative', undefined, undefined);
    // Exit event fires even on error (cleanup path)
    expect(narrativeGen.onSubflowExit).toHaveBeenCalledWith('NarrativeProp', 'sf-narrative', undefined);
  });

  it('factory receives isolated executionRuntime (not the parent)', async () => {
    const deps = makeDeps();
    const { factory, getLastOptions } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'isolationProp',
      subflowId: 'sf-isolation',
      isSubflowRoot: false,
    };
    const context = makeContext();
    const resultsMap = new Map<string, SubflowResult>();

    await executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap);

    // The executionRuntime passed to the factory should be a NEW instance,
    // not the parent's executionRuntime
    expect(getLastOptions().executionRuntime).not.toBe(deps.executionRuntime);
  });
});

// ── Security Tests ───────────────────────────────────────────────────────

describe('SubflowExecutor — security', () => {
  it('inputMapper error is re-thrown after logging', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

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

    await expect(executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap)).rejects.toThrow(
      'input mapping failed',
    );

    expect(context.addError).toHaveBeenCalledWith('inputMapperError', inputError.toString());
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error in inputMapper'),
      expect.objectContaining({ error: inputError }),
    );
  });

  it('outputMapper error is caught (does not crash)', async () => {
    const deps = makeDeps();
    const { factory } = makeFactory();
    const executor = new SubflowExecutor(deps, factory);

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

  it('traversal error is re-thrown after cleanup', async () => {
    const deps = makeDeps();
    const traversalError = new Error('stage exploded');
    const { factory } = makeFactory({ executeError: traversalError });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'errorSubflow',
      subflowId: 'sf-error',
      isSubflowRoot: false,
    };
    const context = makeContext();
    context.getScope.mockReturnValue({});
    const resultsMap = new Map<string, SubflowResult>();

    await expect(executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap)).rejects.toThrow(
      'stage exploded',
    );

    expect(context.addError).toHaveBeenCalledWith('subflowError', traversalError.toString());
    // SubflowResult should still be recorded even on error
    expect(resultsMap.has('sf-error')).toBe(true);
  });

  it('outputMapper is skipped when traversal errored', async () => {
    const deps = makeDeps();
    const outputMapper = vi.fn();
    const { factory } = makeFactory({ executeError: new Error('failed') });
    const executor = new SubflowExecutor(deps, factory);

    const node: StageNode = {
      name: 'skipOutput',
      subflowId: 'sf-skip-output',
      isSubflowRoot: false,
      subflowMountOptions: { outputMapper },
    };
    const context = makeContext();
    context.getScope.mockReturnValue({});
    const resultsMap = new Map<string, SubflowResult>();

    await expect(executor.executeSubflow(node, context, { shouldBreak: false }, undefined, resultsMap)).rejects.toThrow(
      'failed',
    );

    // outputMapper should NOT be called when traversal errored
    expect(outputMapper).not.toHaveBeenCalled();
  });
});
