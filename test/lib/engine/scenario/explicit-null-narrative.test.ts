import { describe, expect, it, vi } from 'vitest';

import {
  createTypedScopeFactory,
  ExecutionRuntime,
  FlowchartTraverser,
  NullControlFlowNarrativeGenerator,
} from '../../../../src/advanced.js';
import { type FlowChart, decide, flowChart, select } from '../../../../src/index.js';

type State = { batch?: number; done?: boolean; result?: string };
const quiet = {
  info: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function advancedHost(chart: FlowChart) {
  const ignored = vi.fn();
  const runtime = new ExecutionRuntime(chart.root.name, chart.root.id);
  const traverser = new FlowchartTraverser({
    root: chart.root,
    stageMap: chart.stageMap,
    subflows: chart.subflows,
    scopeFactory: createTypedScopeFactory<State>(),
    executionRuntime: runtime,
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    narrativeEnabled: true,
    flowRecorders: [
      {
        id: 'explicit-null-takes-precedence',
        onStageExecuted: ignored,
        onDecision: ignored,
        onSelected: ignored,
        onSubflowEntry: ignored,
        onError: ignored,
      },
    ],
    maxIterations: 10,
    logger: quiet,
  });
  return { runtime, traverser, ignored };
}

describe('explicit public no-op strategy in an advanced host', () => {
  it('keeps bounded batch decisions, selected work, commits and break behavior without prose', async () => {
    const work: string[] = [];
    const unreachable = vi.fn();
    const chart = flowChart<State>(
      'Batch',
      (scope) => {
        scope.batch = (scope.batch ?? 0) + 1;
      },
      'batch',
    )
      .addDeciderFunction(
        'Route',
        (scope) => decide(scope, [{ when: { batch: { gte: 3 } }, then: 'done' }], 'work'),
        'route',
      )
      .addFunctionBranch(
        'done',
        'Finish',
        (scope) => {
          scope.done = true;
          scope.$break();
        },
        'finish',
      )
      .addFunctionBranch(
        'work',
        'Work',
        (scope) => {
          work.push('batch:' + scope.batch);
        },
        'work',
      )
      .end()
      .addSelectorFunction(
        'Checks',
        (scope) =>
          select(scope, [
            { when: () => true, then: 'a' },
            { when: () => true, then: 'b' },
          ]),
        'checks',
      )
      .addFunctionBranch(
        'a',
        'Check A',
        (scope) => {
          work.push('a:' + scope.batch);
        },
        'a',
      )
      .addFunctionBranch(
        'b',
        'Check B',
        (scope) => {
          work.push('b:' + scope.batch);
        },
        'b',
      )
      .end()
      .addDeciderFunction(
        'Continue',
        (scope) => decide(scope, [{ when: { done: { eq: true } }, then: 'never' }], 'loop'),
        'continue',
      )
      .addFunctionBranch('never', 'Unreachable', unreachable, 'unreachable')
      .addFunctionBranch('loop', 'Loop', () => undefined, 'loop')
      .end()
      .loopTo('batch')
      .build();
    const { runtime, traverser, ignored } = advancedHost(chart);
    await traverser.execute();
    expect(runtime.getSnapshot().sharedState).toMatchObject({ batch: 3, done: true });
    expect(work.sort()).toEqual(['a:1', 'a:2', 'b:1', 'b:2', 'batch:1', 'batch:2']);
    expect(unreachable).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().commitLog.length).toBeGreaterThan(0);
    expect(ignored).not.toHaveBeenCalled();
    expect(traverser.getNarrative()).toEqual([]);
    const borrowed = traverser.getNarrative();
    borrowed.push('caller-owned sentence');
    expect(traverser.getNarrative()).toEqual([]);
  });

  it('executes a real fork and unmapped child charts while keeping their records', async () => {
    const work: string[] = [];
    const child = (label: string) =>
      flowChart<State>(
        'Child ' + label,
        (scope) => {
          work.push(label);
          scope.result = label;
        },
        'child-' + label,
      ).build();
    const chart = flowChart<State>('Fork', () => undefined, 'fork')
      .addSubFlowChart('A', child('A'), 'a')
      .addSubFlowChart('B', child('B'), 'b')
      .build();
    const { traverser, ignored } = advancedHost(chart);
    await traverser.execute();
    const unique = new Map([...traverser.getSubflowResults().values()].map((row) => [row.subflowId, row]));
    expect(work.sort()).toEqual(['A', 'B']);
    expect([...unique.values()].map((row) => row.treeContext.globalContext.result).sort()).toEqual(['A', 'B']);
    expect([...unique.values()].every((row) => row.treeContext.history.length > 0)).toBe(true);
    expect(traverser.getNarrative()).toEqual([]);
    expect(ignored).not.toHaveBeenCalled();
  });

  it('keeps original failure identity and committed partial work with no narrative', async () => {
    const failure = new Error('business failure');
    const chart = flowChart<State>(
      'Partial',
      (scope) => {
        scope.result = 'partial';
        throw failure;
      },
      'partial',
    ).build();
    const { runtime, traverser, ignored } = advancedHost(chart);
    await expect(traverser.execute()).rejects.toBe(failure);
    expect(runtime.getSnapshot().sharedState.result).toBe('partial');
    expect(runtime.getSnapshot().commitLog.length).toBeGreaterThan(0);
    expect(traverser.getNarrative()).toEqual([]);
    expect(ignored).not.toHaveBeenCalled();
  });
});
