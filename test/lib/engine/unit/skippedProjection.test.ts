import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/index.js';
import { detachStageTopology } from '../../../../src/lib/engine/graph/detachTopology.js';
import {
  type SkippedProjectionOptions,
  projectSkippedChart,
} from '../../../../src/lib/engine/graph/skippedProjection.js';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode.js';

const stage = (id: string, rest?: Partial<StageNode>): StageNode => ({ id, name: id, fn: () => {}, ...rest });
const graphOf = (node: StageNode, options?: SkippedProjectionOptions) => {
  const result = projectSkippedChart(node, options);
  if (result.status === 'unknown') throw new Error(result.reason);
  return result.graph;
};

describe('static skipped-path projection', () => {
  it('projects one real branch-owned loop pass and its direct exit from a built chart', () => {
    const chart = flowChart('Prepare', () => {}, 'prepare')
      .addDeciderFunction('Route', () => 'exit', 'route')
      .addFunctionBranch('again', 'Another pass', () => {})
      .loopTo('prepare')
      .addFunctionBranch('exit', 'Exit', () => {})
      .end()
      .addFunction('Shared tail', () => {}, 'tail')
      .build();
    const detached = detachStageTopology(chart.root);
    const again = chart.root.next?.children?.find((node) => (node.branchId ?? node.id) === 'again');
    if (!detached || !again) throw new Error('Expected the built chart and its return branch');
    const rootWrites = ['stock'];
    const declarations = new Map<StageNode, readonly string[]>([
      [chart.root, rootWrites],
      [again, ['updated']],
    ]);
    const graph = graphOf(detached.root, {
      writesOf: (node) => {
        const authored = detached.authoredOf(node);
        return authored === undefined ? undefined : declarations.get(authored);
      },
    });
    rootWrites.push('later');
    const byStage = (id: string) => {
      const found = graph.stages.find((row) => row.stageId === id && row.role !== 'loop-reference');
      if (!found) throw new Error('Missing fixture stage');
      return found;
    };
    const ref = graph.stages.find((row) => row.role === 'loop-reference');
    expect(ref).toMatchObject({ stageId: 'prepare', edges: [byStage('prepare').id] });
    expect(ref?.id).not.toBe(byStage('prepare').id);
    expect(byStage('prepare').writes).toEqual(['stock']);
    expect(byStage('again')).toMatchObject({ edges: [ref?.id], writes: ['updated'] });
    expect(graph.controls).toEqual([
      {
        placementId: byStage('route').id,
        kind: 'decider',
        continuation: byStage('tail').id,
        choices: [
          {
            entry: byStage('again').id,
            name: 'Another pass',
            loopBack: { body: byStage('prepare').id, exit: byStage('exit').id, owner: byStage('route').id },
          },
          { entry: byStage('exit').id, name: 'Exit' },
        ],
      },
    ]);
  });

  it('keeps one placement for a shared continuation and binds effective branch ids separately', () => {
    const fn = vi.fn(() => {
      throw new Error('no stage should run');
    });
    const shared = stage('tail');
    const first = stage('first', { name: 'First', branchId: 'one', next: shared, fn });
    const second = stage('second', { name: 'Second', branchId: 'two', next: shared, fn });
    const root = stage('route', { selectorFn: true, children: [first, second], next: shared, fn });
    const options: SkippedProjectionOptions = { writesOf: (node) => (node === shared ? [] : undefined) };
    const graph = graphOf(root, options);
    expect(graphOf(root, options)).toEqual(graph);
    const tail = graph.stages.find((row) => row.stageId === 'tail');
    expect(graph.stages.filter((row) => row.stageId === 'tail')).toHaveLength(1);
    expect(tail).toMatchObject({ writes: [] });
    expect(graph.stages.find((row) => row.stageId === 'first')).toMatchObject({ edges: [tail?.id] });
    expect(graph.stages.find((row) => row.stageId === 'second')).toMatchObject({ edges: [tail?.id] });
    expect(graph.controls[0]).toMatchObject({
      kind: 'selector',
      continuation: tail?.id,
      choices: [{ name: 'First' }, { name: 'Second' }],
    });
    const revised = graphOf({ ...root, children: [{ ...first, branchId: 'changed' }, second] }, options);
    expect(revised.controls[0].choices[0].entry).not.toEqual(graph.controls[0].choices[0].entry);
    expect(Object.hasOwn(graph.stages[0], 'writes')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('retains a native fallback clone even when its display name collides', () => {
    const chart = flowChart('Start', () => {}, 'start')
      .addDeciderFunction('Route', () => 'unknown', 'route')
      .addFunctionBranch('keep', 'Keep', () => {})
      .addFunctionBranch('skip', 'Skip', () => {})
      .setDefault('keep')
      .end()
      .build();
    const graph = graphOf(chart.root);
    const fallback = graph.controls[0].choices[2];
    expect(graph.controls[0]).toMatchObject({ continuation: null });
    expect(graph.controls[0].choices[0].name).toEqual(fallback.name);
    expect(fallback.fallback).toBe(true);
    expect(graph.stages.find((row) => row.id === fallback.entry)?.stageId).toBe('default');
  });

  it('refuses to call an implicit shared descendant a skipped branch writer', () => {
    const shared = stage('shared');
    const route = stage('route', {
      deciderFn: true,
      children: [stage('first', { next: shared }), stage('second', { next: shared })],
    });
    expect(projectSkippedChart(route)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
    expect(graphOf({ ...route, next: shared }).stages.filter((row) => row.stageId === 'shared')).toHaveLength(1);
  });

  it('accepts a decider continuation when the traverser can establish its mapped function', () => {
    const tail: StageNode = { id: 'tail', name: 'Tail' };
    const route = stage('route', { deciderFn: true, children: [stage('first'), stage('second')], next: tail });
    expect(projectSkippedChart(route)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
    const graph = graphOf(route, { hasStageFunction: (node) => node === tail });
    expect(graph.controls[0].continuation).toBe(graph.stages.find(({ stageId }) => stageId === tail.id)?.id);
  });

  it('does not inspect a mount body or invoke its lazy resolver', () => {
    const resolver = vi.fn(() => {
      throw new Error('without execution');
    });
    const mount = stage('mount', {
      isSubflowRoot: true,
      subflowResolver: resolver,
      children: [stage('inside', { isDynamicParallel: true })],
      next: stage('tail'),
    });
    const writesOf = vi.fn(() => undefined);
    const graph = graphOf(stage('start', { next: mount }), { writesOf });
    expect(graph.stages.map((row) => [row.stageId, row.role])).toEqual([
      ['start', 'stage'],
      ['mount', 'mount'],
      ['tail', 'stage'],
    ]);
    expect(resolver).not.toHaveBeenCalled();
    expect(writesOf).not.toHaveBeenCalledWith(mount);
  });

  it('refuses missing or duplicate loop targets and a loop without a unique exit', () => {
    const ref: StageNode = { id: 'body', name: 'body', isLoopRef: true };
    const loop = stage('repeat', { next: ref });
    const gate = stage('route', { deciderFn: true, children: [loop, stage('exit')] });
    expect(projectSkippedChart(gate)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
    const duplicate = stage('body', { children: [stage('body')], next: gate });
    expect(projectSkippedChart(duplicate)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
    const multipleExits = stage('body', {
      next: { ...gate, children: [...(gate.children ?? []), stage('also-exit')] },
    });
    expect(projectSkippedChart(multipleExits)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
  });

  it('refuses dynamic fan-out, unchecked cycles, and graph accessors', () => {
    const cyclic = stage('cyclic');
    cyclic.next = cyclic;
    const getter = vi.fn(() => stage('child'));
    const accessor = Object.defineProperty(stage('untrusted'), 'next', { get: getter });
    for (const node of [stage('each', { isDynamicParallel: true }), cyclic, accessor])
      expect(projectSkippedChart(node)).toEqual({ status: 'unknown', reason: 'graph-ambiguous' });
    expect(getter).not.toHaveBeenCalled();
    expect(projectSkippedChart(stage('bounded', { next: stage('next') }), { work: 1 })).toEqual({
      status: 'unknown',
      reason: 'truncated',
    });
  });

  it('refuses sparse, accessor-backed, and unsafe declarations', () => {
    const root = stage('root');
    const getter = vi.fn(() => 'stock');
    const accessor: string[] = [];
    Object.defineProperty(accessor, '0', { get: getter });
    for (const paths of [Array<string>(1), accessor, ['__proto__']]) {
      expect(projectSkippedChart(root, { writesOf: () => paths })).toEqual({
        status: 'unknown',
        reason: 'graph-ambiguous',
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
