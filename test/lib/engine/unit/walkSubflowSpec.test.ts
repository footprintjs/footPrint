/**
 * Unit tests for walkSubflowSpec — the public structural walker
 * over the spec delivered via StructureRecorder.onSubflowMounted.
 *
 * Walker contract (per proposal #001-v6):
 *   1. subflow-start marker yielded FIRST for each subflow
 *   2. Auto-recurse with composed paths (`parent/child/...`)
 *   3. {recurse: false} skips nested internals
 *   4. Item shapes mirror Structure event payloads + subflowPath + source
 *   5. source: 'walker' on every item
 *   6. Stage IDs in nested subflows already prefixed by spec
 */

import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../../src/lib/builder/FlowChartBuilder';
import { decide, select } from '../../../../src/lib/decide';
import type { WalkerItem } from '../../../../src/lib/engine/walkSubflowSpec';
import { walkSubflowSpec } from '../../../../src/lib/engine/walkSubflowSpec';

const noop = async () => ({});

/** Collect walker edges + a `from→to` membership helper. */
function edgesOf(items: WalkerItem[]) {
  const edges = items.filter((i) => i.kind === 'edge') as Extract<WalkerItem, { kind: 'edge' }>[];
  return { has: (from: string, to: string) => edges.some((e) => e.from === from && e.to === to) };
}

describe('walkSubflowSpec', () => {
  it('yields subflow-start FIRST, then stage, for a single-stage spec', () => {
    const chart = flowChart('seed', noop, 'seed').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'sub-1')];

    expect(items[0]).toMatchObject({ kind: 'subflow-start', stageId: 'seed', subflowPath: 'sub-1' });
    expect(items[1]).toMatchObject({ kind: 'stage', stageId: 'seed', subflowPath: 'sub-1' });
  });

  it('every item carries source: "walker"', () => {
    const chart = flowChart('seed', noop, 'seed').addFunction('a', noop, 'a').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'sub-1')];
    for (const item of items) {
      expect(item.source).toBe('walker');
    }
  });

  it('linear chain — yields stages + next edges in order', () => {
    const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').addFunction('c', noop, 'c').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'sub-1')];

    // Expected sequence: subflow-start, stage(a), edge(a→b, next), stage(b), edge(b→c, next), stage(c)
    expect(items.map((i) => i.kind)).toEqual(['subflow-start', 'stage', 'edge', 'stage', 'edge', 'stage']);
    const edges = items.filter((i) => i.kind === 'edge') as Extract<WalkerItem, { kind: 'edge' }>[];
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 'a', to: 'b', edgeKind: 'next' });
    expect(edges[1]).toMatchObject({ from: 'b', to: 'c', edgeKind: 'next' });
  });

  it('loop — yields loop item with from/to', () => {
    const chart = flowChart('seed', noop, 'seed').addFunction('a', noop, 'a').loopTo('seed').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'sub-1')];
    const loops = items.filter((i) => i.kind === 'loop') as Extract<WalkerItem, { kind: 'loop' }>[];
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ from: 'a', to: 'seed', subflowPath: 'sub-1' });
  });

  it('subflowPath propagates onto every yielded item', () => {
    const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'auth/verify')];
    for (const item of items) {
      expect(item.subflowPath).toBe('auth/verify');
    }
  });

  it('nested subflow — auto-recurses with composed path by default', () => {
    const inner = flowChart('inner-a', noop, 'inner-a').addFunction('inner-b', noop, 'inner-b').build();
    const outer = flowChart('outer-a', noop, 'outer-a').addSubFlowChartNext('nested', inner, 'Nested').build();

    const items = [...walkSubflowSpec(outer.buildTimeStructure, 'auth')];
    // Outer-level items
    const outerStages = items.filter((i) => i.kind === 'stage' && i.subflowPath === 'auth');
    expect(outerStages.length).toBeGreaterThan(0);
    // Nested subflow marker
    const nestedMarkers = items.filter((i) => i.kind === 'subflow') as Extract<WalkerItem, { kind: 'subflow' }>[];
    expect(nestedMarkers).toHaveLength(1);
    expect(nestedMarkers[0]).toMatchObject({
      mountStageId: 'nested',
      subflowId: 'nested',
      subflowName: 'Nested',
      subflowPath: 'auth/nested',
    });
    // Nested entry-start under composed path
    const nestedStarts = items.filter((i) => i.kind === 'subflow-start' && i.subflowPath === 'auth/nested');
    expect(nestedStarts.length).toBeGreaterThanOrEqual(1);
    // Nested stages tagged with composed path
    const nestedStages = items.filter((i) => i.kind === 'stage' && i.subflowPath === 'auth/nested');
    expect(nestedStages.length).toBeGreaterThan(0);
  });

  it('{recurse: false} skips nested internals but still yields the subflow marker', () => {
    const inner = flowChart('inner-a', noop, 'inner-a').addFunction('inner-b', noop, 'inner-b').build();
    const outer = flowChart('outer-a', noop, 'outer-a').addSubFlowChartNext('nested', inner, 'Nested').build();

    const items = [...walkSubflowSpec(outer.buildTimeStructure, 'auth', { recurse: false })];
    // Subflow marker still present
    const nestedMarkers = items.filter((i) => i.kind === 'subflow');
    expect(nestedMarkers).toHaveLength(1);
    // No items under the composed nested path
    const nestedInternals = items.filter((i) => i.kind !== 'subflow' && i.subflowPath === 'auth/nested');
    expect(nestedInternals).toHaveLength(0);
  });

  it('stage item mirrors event payload shape (stageId, name, type, spec)', () => {
    const chart = flowChart('seed', noop, 'seed').build();
    const items = [...walkSubflowSpec(chart.buildTimeStructure, 'sub-1')];
    const stageItem = items.find((i) => i.kind === 'stage') as Extract<WalkerItem, { kind: 'stage' }>;
    expect(stageItem).toBeDefined();
    expect(stageItem).toMatchObject({
      stageId: 'seed',
      name: 'seed',
      type: 'stage',
      subflowPath: 'sub-1',
      source: 'walker',
    });
    // Spec reference points to the actual node in the spec tree
    expect(stageItem.spec).toBe(chart.buildTimeStructure);
  });
});

// Fan-out convergence is INFERRED, not flagged: a selector/fork's branches
// ALWAYS converge at the node's `next` (engine semantics — every branch runs,
// then next runs). The walker renders the true topology — fork → branches →
// join — with each branch → join and the node's direct → next "skip" edge
// suppressed. Deciders (one branch chosen, branches genuinely diverge) are NOT
// fan-outs and keep their direct → next edge.
describe('walkSubflowSpec — fan-out convergence (inferred)', () => {
  it('selector — branches converge at next; the direct skip edge is suppressed', () => {
    const chart = flowChartSelector(
      'Pick',
      (s: never) =>
        select(s, [
          { when: () => true, then: 'a', label: 'a' },
          { when: () => true, then: 'b', label: 'b' },
        ]),
      'pick',
    )
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .addFunction('join', noop, 'join')
      .build();

    const { has } = edgesOf([...walkSubflowSpec(chart.buildTimeStructure, 'sub')]);
    // Each branch merges into the join...
    expect(has('a', 'join')).toBe(true);
    expect(has('b', 'join')).toBe(true);
    // ...and the selector's direct fork→join "skip" edge is gone.
    expect(has('pick', 'join')).toBe(false);
    // The fork edges themselves remain.
    expect(has('pick', 'a')).toBe(true);
    expect(has('pick', 'b')).toBe(true);
  });

  it('decider — branches do NOT auto-converge; the direct next edge is kept', () => {
    const chart = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Route', (s: never) => decide(s, [{ when: () => true, then: 'x', label: 'x' }], 'y'), 'route')
      .addFunctionBranch('x', 'X', noop)
      .addFunctionBranch('y', 'Y', noop)
      .end()
      .addFunction('join', noop, 'join')
      .build();

    const { has } = edgesOf([...walkSubflowSpec(chart.buildTimeStructure, 'sub')]);
    // A decider's branches genuinely diverge — no inferred convergence edges.
    expect(has('x', 'join')).toBe(false);
    expect(has('y', 'join')).toBe(false);
    // The decider keeps its own direct → next edge (unchanged behavior).
    expect(has('route', 'join')).toBe(true);
  });
});
