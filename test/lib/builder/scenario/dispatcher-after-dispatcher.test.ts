/**
 * Scenario: a dispatcher right after a dispatcher.
 *
 * `.end()` leaves the cursor ON the closed decider/selector, and the next
 * `addDeciderFunction` / `addSelectorFunction` builds a NEW node at its
 * `next`. Until 10.0.1 both methods tested the dispatcher flags of that
 * PREVIOUS node (a guard from v0.1.0), so three of the four orders were
 * refused at build time ("decider already defined", "selector already
 * defined", "mutually exclusive") while selector → decider was accepted.
 * The engine always ran all four. Each order here builds, runs both
 * dispatchers' chosen branches in sequence, and serializes both nodes with
 * their own type — in the build-time spec, through `computeNodeType`, in the
 * run-time structure and in the structure events.
 */
import { describe, expect, it } from 'vitest';

import type { StageNode } from '../../../../src/lib/builder';
import { flowChart } from '../../../../src/lib/builder';
import type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureRecorder,
} from '../../../../src/lib/builder/structure/StructureRecorder';
import { computeNodeType, RuntimeStructureManager } from '../../../../src/lib/engine/handlers/RuntimeStructureManager';
import type { FlowDecisionEvent, FlowSelectedEvent } from '../../../../src/lib/engine/narrative/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type Kind = 'decider' | 'selector';

/**
 * Each dispatcher has three branches. A decider picks ONE; a selector picks
 * TWO, so the run also shows a multi-branch fan-out joining before the next
 * dispatcher.
 */
const PICKS: Record<Kind, readonly string[]> = { decider: ['1'], selector: ['1', '2'] };

/** The branch ids under dispatcher `n` (`d1` → `d1-1`, `d1-2`, `d1-3`). */
const branchIdsOf = (n: string): string[] => ['1', '2', '3'].map((b) => `${n}-${b}`);
const picksOf = (kind: Kind, n: string): string[] => PICKS[kind].map((b) => `${n}-${b}`);

function buildChain(first: Kind, second: Kind, order: string[], recorder?: StructureRecorder) {
  const stage = (label: string) => () => {
    order.push(label);
  };
  const dispatcher = (kind: Kind, n: string) => () => {
    order.push(n);
    const picks = picksOf(kind, n);
    return kind === 'decider' ? picks[0] : picks;
  };

  let builder = flowChart('A', stage('a'), 'a');
  if (recorder) builder = builder.attachStructureRecorder(recorder);

  const open = (b: typeof builder, kind: Kind, n: string) =>
    kind === 'decider'
      ? b.addDeciderFunction(n.toUpperCase(), dispatcher(kind, n), n)
      : b.addSelectorFunction(n.toUpperCase(), dispatcher(kind, n), n);

  let list = open(builder, first, 'd1');
  for (const id of branchIdsOf('d1')) list = list.addFunctionBranch(id, id.toUpperCase(), stage(id)) as typeof list;
  let next = open(list.end(), second, 'd2');
  for (const id of branchIdsOf('d2')) next = next.addFunctionBranch(id, id.toUpperCase(), stage(id)) as typeof next;
  return next.end().addFunction('Z', stage('z'), 'z').build();
}

/** A selector's picks run in parallel, so only their SET is pinned. */
function expectRunOrder(order: string[], first: Kind, second: Kind): void {
  const p1 = picksOf(first, 'd1');
  const p2 = picksOf(second, 'd2');
  expect(order).toHaveLength(4 + p1.length + p2.length);
  let at = 0;
  expect(order[at++]).toBe('a');
  expect(order[at++]).toBe('d1');
  expect(new Set(order.slice(at, (at += p1.length)))).toEqual(new Set(p1));
  expect(order[at++]).toBe('d2');
  expect(new Set(order.slice(at, (at += p2.length)))).toEqual(new Set(p2));
  expect(order[at]).toBe('z');
}

const flagOf = (kind: Kind): 'deciderFn' | 'selectorFn' => (kind === 'decider' ? 'deciderFn' : 'selectorFn');

const ORDERS: ReadonlyArray<readonly [Kind, Kind]> = [
  ['decider', 'decider'],
  ['decider', 'selector'],
  ['selector', 'selector'],
  ['selector', 'decider'],
];

describe.each(ORDERS)('Scenario: a %s, then a %s', (first, second) => {
  it('builds: the second dispatcher is a new node at the first one’s next', () => {
    const chart = buildChain(first, second, []);
    const d1 = chart.root.next as StageNode;
    const d2 = d1.next as StageNode;

    expect(d1.id).toBe('d1');
    expect(d1[flagOf(first)]).toBe(true);
    expect(d1[flagOf(first === 'decider' ? 'selector' : 'decider')]).toBeUndefined();
    expect(d1.children?.map((c) => c.id)).toEqual(branchIdsOf('d1'));

    expect(d2.id).toBe('d2');
    expect(d2[flagOf(second)]).toBe(true);
    expect(d2[flagOf(second === 'decider' ? 'selector' : 'decider')]).toBeUndefined();
    expect(d2.children?.map((c) => c.id)).toEqual(branchIdsOf('d2'));
    expect(d2.next?.id).toBe('z');
  });

  it('computeNodeType names each dispatcher by its own flag', () => {
    const chart = buildChain(first, second, []);
    expect(computeNodeType(chart.root)).toBe('stage');
    expect(computeNodeType(chart.root.next!)).toBe(first);
    expect(computeNodeType(chart.root.next!.next!)).toBe(second);
    expect(computeNodeType(chart.root.next!.next!.next!)).toBe('stage');
  });

  it('the build-time spec carries both dispatchers with their own type and branchIds', () => {
    const spec = buildChain(first, second, []).buildTimeStructure;
    const s1 = spec.next!;
    const s2 = s1.next!;

    expect(s1.type).toBe(first);
    expect(Boolean(s1.hasDecider)).toBe(first === 'decider');
    expect(Boolean(s1.hasSelector)).toBe(first === 'selector');
    expect(s1.branchIds).toEqual(branchIdsOf('d1'));

    expect(s2.type).toBe(second);
    expect(Boolean(s2.hasDecider)).toBe(second === 'decider');
    expect(Boolean(s2.hasSelector)).toBe(second === 'selector');
    expect(s2.branchIds).toEqual(branchIdsOf('d2'));
    expect(s2.next?.id).toBe('z');
  });

  it('the run-time serializer agrees with the build-time spec', () => {
    const chart = buildChain(first, second, []);
    const runtime = new RuntimeStructureManager().stageNodeToStructure(chart.root);
    const build = chart.buildTimeStructure;
    for (const [r, b] of [
      [runtime.next!, build.next!],
      [runtime.next!.next!, build.next!.next!],
    ]) {
      expect(r.id).toBe(b.id);
      expect(r.type).toBe(b.type);
      expect(Boolean(r.hasDecider)).toBe(Boolean(b.hasDecider));
      expect(Boolean(r.hasSelector)).toBe(Boolean(b.hasSelector));
      expect(r.branchIds).toEqual(b.branchIds);
    }
  });

  it('structure events: one completion per dispatcher, and every d1 branch converges on d2', () => {
    const completions: StructureDeciderCompleteEvent[] = [];
    const edges: StructureEdgeAddedEvent[] = [];
    buildChain(first, second, [], {
      id: 'spy',
      onDeciderComplete: (e) => completions.push(e),
      onEdgeAdded: (e) => edges.push(e),
    });

    expect(completions.map((e) => [e.decider, e.type, e.branchIds])).toEqual([
      ['d1', first, branchIdsOf('d1')],
      ['d2', second, branchIdsOf('d2')],
    ]);
    const nextEdges = edges.filter((e) => e.kind === 'next').map((e) => `${e.from}->${e.to}`);
    expect(nextEdges).toEqual([
      'a->d1',
      ...branchIdsOf('d1').map((id) => `${id}->d2`),
      ...branchIdsOf('d2').map((id) => `${id}->z`),
    ]);
  });

  it('runs: d1, its chosen branches, then d2, its chosen branches, then the rest', async () => {
    const order: string[] = [];
    const decisions: FlowDecisionEvent[] = [];
    const selections: FlowSelectedEvent[] = [];
    const executor = new FlowChartExecutor(buildChain(first, second, order));
    executor.attachFlowRecorder({
      id: 'choices',
      onDecision: (e) => decisions.push(e),
      onSelected: (e) => selections.push(e),
    });
    await executor.run();

    expectRunOrder(order, first, second);
    const expected = [
      [first, 'd1'],
      [second, 'd2'],
    ] as const;
    // Both events name the chosen branch STAGES (their names: the ids upper-cased here).
    const names = (kind: Kind, n: string) => picksOf(kind, n).map((id) => id.toUpperCase());
    expect(decisions.map((e) => e.chosen)).toEqual(
      expected.filter(([k]) => k === 'decider').map(([k, n]) => names(k, n)[0]),
    );
    expect(selections.map((e) => [...e.selected].sort())).toEqual(
      expected.filter(([k]) => k === 'selector').map(([k, n]) => names(k, n)),
    );
    expect(executor.getRuntimeStructure()?.next?.type).toBe(first);
    expect(executor.getRuntimeStructure()?.next?.next?.type).toBe(second);
  });
});
