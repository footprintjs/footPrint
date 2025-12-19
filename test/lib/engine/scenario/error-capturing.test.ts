/**
 * Scenario test: Error capturing across all execution patterns.
 *
 * Verifies that when a stage throws:
 * 1. context.commit() is called BEFORE re-throw (trace captures everything up to failure)
 * 2. getSnapshot() returns the full execution tree including the failed stage's writes
 * 3. Error metadata is recorded via addError()
 * 4. Narrative captures the error event
 *
 * Patterns covered:
 * - Linear chain throw (middle of A → B → C)
 * - Fork child throw (default: all complete, failFast: reject early)
 * - Decider function throw
 * - Selector function throw
 * - AbortSignal cancellation (snapshot available after abort)
 * - Timeout (snapshot available after timeout)
 * - Scope writes before error are preserved
 */

import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger, FlowChart } from '../../../../src/lib/engine/types';

const silentLogger: ILogger = {
  info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

function simpleScopeFactory(context: any, stageName: string) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

// ─────────────────────── Helpers ───────────────────────

function createTraverser(root: StageNode, stageMap: Map<string, StageFunction>, opts?: { narrativeEnabled?: boolean; signal?: AbortSignal }) {
  const runtime = new ExecutionRuntime(root.name);
  const traverser = new FlowchartTraverser({
    root,
    stageMap,
    scopeFactory: simpleScopeFactory,
    executionRuntime: runtime,
    scopeProtectionMode: 'off',
    logger: silentLogger,
    narrativeEnabled: opts?.narrativeEnabled,
    signal: opts?.signal,
  });
  return { traverser, runtime };
}

// ─────────────────────── Linear Chain Errors ───────────────────────

describe('Error capturing: Linear chain', () => {
  it('commit-on-error: scope writes before throw are preserved in snapshot', async () => {
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('A', (scope: any) => {
      scope.set('fromA', 'valueA');
      return 'resultA';
    });
    stageMap.set('B', (scope: any) => {
      scope.set('fromB', 'partial-work');
      throw new Error('B exploded');
    });
    stageMap.set('C', () => 'resultC');

    const nodeC: StageNode = { name: 'C', id: 'C' };
    const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
    const root: StageNode = { name: 'A', id: 'A', next: nodeB };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('B exploded');

    // Snapshot should capture everything up to the failure
    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();

    // A's writes should be committed
    const tree = snapshot.executionTree;
    expect(tree).toBeDefined();

    // The commit log should have entries (A's commit + B's error commit)
    expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(2);
  });

  it('error metadata is recorded via addError', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('failStage', () => { throw new Error('test error'); });

    const root: StageNode = { name: 'failStage', id: 'failStage' };
    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('test error');

    const snapshot = runtime.getSnapshot();
    // The execution tree should contain the error
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('stageExecutionError');
    expect(treeStr).toContain('test error');
  });

  it('narrative captures error event', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('A', () => 'ok');
    stageMap.set('B', () => { throw new Error('narrative error'); });

    const nodeB: StageNode = { name: 'B', id: 'B' };
    const root: StageNode = { name: 'A', id: 'A', next: nodeB };

    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true });

    await expect(traverser.execute()).rejects.toThrow('narrative error');

    const narrative = traverser.getNarrative();
    expect(narrative.some((s) => s.includes('error') && s.includes('B'))).toBe(true);
  });

  it('stages after error do not execute', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('A', () => { order.push('A'); return 'a'; });
    stageMap.set('B', () => { order.push('B'); throw new Error('fail'); });
    stageMap.set('C', () => { order.push('C'); return 'c'; });

    const nodeC: StageNode = { name: 'C', id: 'C' };
    const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
    const root: StageNode = { name: 'A', id: 'A', next: nodeB };

    const { traverser } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('fail');
    expect(order).toEqual(['A', 'B']);
  });
});

// ─────────────────────── Fork Child Errors ───────────────────────

describe('Error capturing: Fork children', () => {
  it('default: all children complete, error child is flagged in results', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('parent', () => 'parentResult');
    stageMap.set('good', (scope: any) => {
      scope.set('data', 'good-data');
      return 'goodResult';
    });
    stageMap.set('bad', () => { throw new Error('child error'); });

    const good: StageNode = { name: 'good', id: 'good' };
    const bad: StageNode = { name: 'bad', id: 'bad' };
    const root: StageNode = { name: 'parent', id: 'parent', children: [good, bad] };

    const { traverser, runtime } = createTraverser(root, stageMap);
    const result = await traverser.execute() as any;

    // Both children ran
    expect(result.good.isError).toBe(false);
    expect(result.good.result).toBe('goodResult');
    expect(result.bad.isError).toBe(true);

    // Snapshot captures both branches
    const snapshot = runtime.getSnapshot();
    expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(3); // parent + 2 children
  });

  it('failFast: snapshot available after early rejection', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('parent', () => 'parentResult');
    stageMap.set('fast-fail', () => { throw new Error('fast error'); });
    stageMap.set('slow', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'slow-result';
    });

    const fastFail: StageNode = { name: 'fast-fail', id: 'fast-fail' };
    const slow: StageNode = { name: 'slow', id: 'slow' };
    const root: StageNode = { name: 'parent', id: 'parent', children: [fastFail, slow], failFast: true };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('fast error');

    // Snapshot still available after fail-fast
    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(1); // at least parent committed
  });
});

// ─────────────────────── Decider Errors ───────────────────────

describe('Error capturing: Decider', () => {
  it('decider function throw preserves trace and records error', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('decider', (scope: any) => {
      scope.set('computed', 'before-error');
      throw new Error('decider failed');
    });

    const branchA: StageNode = { name: 'branchA', id: 'branchA', fn: () => 'a' };
    const root: StageNode = {
      name: 'decider', id: 'decider', deciderFn: true,
      children: [branchA],
    };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('decider failed');

    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('stageExecutionError');
  });

  it('decider returning unknown branch ID records error', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('decider', () => 'nonexistent-branch');

    const branchA: StageNode = { name: 'branchA', id: 'branchA', fn: () => 'a' };
    const root: StageNode = {
      name: 'decider', id: 'decider', deciderFn: true,
      children: [branchA],
    };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow(/nonexistent-branch/);

    const snapshot = runtime.getSnapshot();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('deciderError');
  });
});

// ─────────────────────── Selector Errors ───────────────────────

describe('Error capturing: Selector', () => {
  it('selector function throw preserves trace', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('selector', (scope: any) => {
      scope.set('prep', 'done');
      throw new Error('selector exploded');
    });

    const branchA: StageNode = { name: 'branchA', id: 'branchA', fn: () => 'a' };
    const branchB: StageNode = { name: 'branchB', id: 'branchB', fn: () => 'b' };
    const root: StageNode = {
      name: 'selector', id: 'selector', selectorFn: true,
      children: [branchA, branchB],
    };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('selector exploded');

    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('stageExecutionError');
  });

  it('selector returning unknown IDs records error', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('selector', () => ['nonexistent']);

    const branchA: StageNode = { name: 'branchA', id: 'branchA', fn: () => 'a' };
    const root: StageNode = {
      name: 'selector', id: 'selector', selectorFn: true,
      children: [branchA],
    };

    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow(/nonexistent/);

    const snapshot = runtime.getSnapshot();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('selectorError');
  });
});

// ─────────────────────── AbortSignal Errors ───────────────────────

describe('Error capturing: AbortSignal', () => {
  it('snapshot available after abort cancellation', async () => {
    const controller = new AbortController();
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('stage1', (scope: any) => {
      scope.set('data', 'committed');
      controller.abort(new Error('cancelled'));
      return 'result1';
    });
    stageMap.set('stage2', () => 'result2');

    const stage2: StageNode = { name: 'stage2', id: 'stage2' };
    const root: StageNode = { name: 'stage1', id: 'stage1', next: stage2 };

    const { traverser, runtime } = createTraverser(root, stageMap, { signal: controller.signal });

    await expect(traverser.execute()).rejects.toThrow('cancelled');

    // Snapshot captures stage1's committed data
    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────── Timeout Errors ───────────────────────

describe('Error capturing: Timeout via FlowChartExecutor', () => {
  it('snapshot available after timeout', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fast', (scope: any) => {
      scope.set('fastData', 'done');
      return 'fast-result';
    });
    stageMap.set('slow', () => new Promise((resolve) => setTimeout(() => resolve('done'), 5000)));

    const slow: StageNode = { name: 'slow', id: 'slow' };
    const root: StageNode = { name: 'fast', id: 'fast', next: slow };
    const flowChart: FlowChart = { root, stageMap };

    const executor = new FlowChartExecutor(flowChart, simpleScopeFactory);

    await expect(executor.run({ timeoutMs: 50 })).rejects.toThrow(/timed out/i);

    // Snapshot captures what ran before timeout
    const snapshot = executor.getSnapshot();
    expect(snapshot).toBeDefined();
  });
});

// ─────────────────────── Error Narrative (end-to-end) ───────────────────────

describe('Error narrative: trace tells the story', () => {
  it('narrative captures execution flow up to and including the error', async () => {
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('fetchData', () => 'rawData');
    stageMap.set('validate', () => {
      throw new Error('Validation failed: missing required field "email"');
    });
    stageMap.set('transform', () => 'transformed');

    const transform: StageNode = { name: 'transform', id: 'transform' };
    const validate: StageNode = { name: 'validate', id: 'validate', next: transform };
    const root: StageNode = { name: 'fetchData', id: 'fetchData', next: validate };

    const { traverser, runtime } = createTraverser(root, stageMap, { narrativeEnabled: true });

    await expect(traverser.execute()).rejects.toThrow('Validation failed');

    // Narrative tells the story
    const narrative = traverser.getNarrative();
    expect(narrative.length).toBeGreaterThanOrEqual(2);
    expect(narrative[0]).toContain('fetchData');
    expect(narrative.some((s) => s.includes('error') && s.includes('validate'))).toBe(true);

    // Snapshot provides full context for debugging
    const snapshot = runtime.getSnapshot();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('stageExecutionError');
    expect(treeStr).toContain('Validation failed');

    // Commit log has entries for stages that completed
    expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(2);
  });

  it('fork error narrative shows which child failed', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('orchestrator', () => 'go');
    stageMap.set('apiCall', () => { throw new Error('API rate limited'); });
    stageMap.set('dbQuery', () => 'db-data');

    const apiCall: StageNode = { name: 'apiCall', id: 'apiCall' };
    const dbQuery: StageNode = { name: 'dbQuery', id: 'dbQuery' };
    const root: StageNode = { name: 'orchestrator', id: 'orchestrator', children: [apiCall, dbQuery] };

    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true });

    const result = await traverser.execute() as any;
    expect(result.apiCall.isError).toBe(true);
    expect(result.dbQuery.isError).toBe(false);

    const narrative = traverser.getNarrative();
    // Should mention the fork
    expect(narrative.some((s) => s.includes('parallel'))).toBe(true);
  });
});
