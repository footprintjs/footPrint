/**
 * RFC-003 D3 — control-dependence edges in the backtracker.
 *
 * `causalChain(log, id, keysRead, { controlDeps })` links every expanded
 * node to its governing decider with a `kind: 'control'` edge (labeled by
 * the decide() rule label when present). The decider then expands normally
 * through its OWN data reads — the canonical fixture chains end-to-end:
 *
 *   status ← [control] ClassifyRisk ← [data: creditScore] PullBureau
 *
 * Sections:
 * - unit: CausalEdge shape, parentEdges vs parents semantics
 * - control expansion: end-to-end chain, labels, nesting, dedup
 * - compat: no controlDeps → byte-identical legacy behavior
 * - limits: node budget applies to control-discovered nodes
 */

import { describe, expect, it } from 'vitest';

import type { ControlDepLookup } from '../../../src/lib/memory/backtrack.js';
import { causalChain, flattenCausalDAG, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';

// ── Test helpers ───────────────────────────────────────────────────────

function commit(stageId: string, runtimeStageId: string, keysWritten: string[], idx: number): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: keysWritten.map((k) => ({ path: k, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: Object.fromEntries(keysWritten.map((k) => [k, `val-${k}`])),
    updates: {},
  };
}

function readsFrom(map: Record<string, string[]>): (id: string) => string[] {
  return (id: string) => map[id] ?? [];
}

function controlFrom(map: Record<string, { deciderId: string; label?: string }>): ControlDepLookup {
  return (id) => map[id];
}

/**
 * The canonical credit fixture:
 *   pull-bureau#0  writes creditScore           (data source)
 *   classify#1     reads creditScore, decides   (decider — empty commit)
 *   approve#2      writes status                (chosen branch)
 */
function creditFixture() {
  const log = [
    commit('pull-bureau', 'pull-bureau#0', ['creditScore'], 0),
    commit('classify', 'classify#1', [], 1),
    commit('approve', 'approve#2', ['status'], 2),
  ];
  const reads = readsFrom({
    'classify#1': ['creditScore'],
    'approve#2': [],
  });
  const controlDeps = controlFrom({
    'approve#2': { deciderId: 'classify#1', label: 'Good credit' },
  });
  return { log, reads, controlDeps };
}

// ════════════════════════════════════════════════════════════════════════

describe('causalChain — control-dependence expansion (D3)', () => {
  it('chains end-to-end: status ← [control] classify ← [data: creditScore] pull-bureau', () => {
    const { log, reads, controlDeps } = creditFixture();
    const root = causalChain(log, 'approve#2', reads, { controlDeps })!;

    // approve has NO data parents (it read nothing) but ONE control parent
    expect(root.parents).toHaveLength(1);
    expect(root.parentEdges).toHaveLength(1);

    const controlEdge = root.parentEdges[0];
    expect(controlEdge.kind).toBe('control');
    expect(controlEdge.key).toBe('Good credit');
    expect(controlEdge.weight).toBe(1.0);
    expect(controlEdge.parent.runtimeStageId).toBe('classify#1');

    // The decider expands through its OWN data reads
    const classify = controlEdge.parent;
    expect(classify.parentEdges).toHaveLength(1);
    expect(classify.parentEdges[0].kind).toBe('data');
    expect(classify.parentEdges[0].key).toBe('creditScore');
    expect(classify.parentEdges[0].parent.runtimeStageId).toBe('pull-bureau#0');
  });

  it('control edge label is optional — absent when the decision carried none', () => {
    const { log, reads } = creditFixture();
    const controlDeps = controlFrom({ 'approve#2': { deciderId: 'classify#1' } });
    const root = causalChain(log, 'approve#2', reads, { controlDeps })!;

    expect(root.parentEdges[0].kind).toBe('control');
    expect(root.parentEdges[0].key).toBeUndefined();
  });

  it('nested control: the decider itself can be control-dependent on an outer decider', () => {
    const log = [
      commit('outer-decide', 'outer-decide#0', [], 0),
      commit('inner-decide', 'inner-decide#1', [], 1),
      commit('leaf', 'leaf#2', ['out'], 2),
    ];
    const reads = readsFrom({});
    const controlDeps = controlFrom({
      'leaf#2': { deciderId: 'inner-decide#1', label: 'inner rule' },
      'inner-decide#1': { deciderId: 'outer-decide#0', label: 'outer rule' },
    });

    const root = causalChain(log, 'leaf#2', reads, { controlDeps })!;
    const inner = root.parentEdges[0].parent;
    expect(inner.runtimeStageId).toBe('inner-decide#1');
    const outer = inner.parentEdges[0].parent;
    expect(outer.runtimeStageId).toBe('outer-decide#0');
    expect(inner.parentEdges[0].kind).toBe('control');
    expect(inner.parentEdges[0].key).toBe('outer rule');
  });

  it('dual link: a node both reads FROM and is controlled BY the same parent → 1 parent, 2 edges', () => {
    const log = [commit('decide', 'decide#0', ['routingNote'], 0), commit('branch', 'branch#1', ['out'], 1)];
    const reads = readsFrom({ 'branch#1': ['routingNote'] });
    const controlDeps = controlFrom({ 'branch#1': { deciderId: 'decide#0', label: 'rule' } });

    const root = causalChain(log, 'branch#1', reads, { controlDeps })!;
    expect(root.parents).toHaveLength(1);
    expect(root.parentEdges).toHaveLength(2);
    expect(root.parentEdges.map((e) => e.kind).sort()).toEqual(['control', 'data']);
  });

  it('decider id missing from the commit log → no edge, no crash', () => {
    const { log, reads } = creditFixture();
    const controlDeps = controlFrom({ 'approve#2': { deciderId: 'ghost#99' } });
    const root = causalChain(log, 'approve#2', reads, { controlDeps })!;
    expect(root.parents).toHaveLength(0);
    expect(root.parentEdges).toHaveLength(0);
  });

  it('control parent is deduped across multiple children (DAG, not tree)', () => {
    // Two branch stages, both governed by the same decision
    const log = [
      commit('decide', 'decide#0', [], 0),
      commit('write-a', 'write-a#1', ['a'], 1),
      commit('write-b', 'write-b#2', ['b'], 2),
      commit('join', 'join#3', ['joined'], 3),
    ];
    const reads = readsFrom({ 'join#3': ['a', 'b'] });
    const controlDeps = controlFrom({
      'write-a#1': { deciderId: 'decide#0' },
      'write-b#2': { deciderId: 'decide#0' },
    });

    const root = causalChain(log, 'join#3', reads, { controlDeps })!;
    const flat = flattenCausalDAG(root);
    expect(flat.filter((n) => n.runtimeStageId === 'decide#0')).toHaveLength(1);

    const writeA = flat.find((n) => n.runtimeStageId === 'write-a#1')!;
    const writeB = flat.find((n) => n.runtimeStageId === 'write-b#2')!;
    expect(writeA.parentEdges[0].parent).toBe(writeB.parentEdges[0].parent);
  });
});

describe('causalChain — parentEdges semantics (D3)', () => {
  it('a node reading TWO keys from the same writer: 1 parent, 2 data edges', () => {
    const log = [commit('writer', 'writer#0', ['x', 'y'], 0), commit('reader', 'reader#1', ['z'], 1)];
    const reads = readsFrom({ 'reader#1': ['x', 'y'] });

    const root = causalChain(log, 'reader#1', reads)!;
    expect(root.parents).toHaveLength(1);
    expect(root.parentEdges).toHaveLength(2);
    expect(root.parentEdges.map((e) => e.key).sort()).toEqual(['x', 'y']);
    expect(root.parentEdges.every((e) => e.kind === 'data' && e.weight === 1.0)).toBe(true);
  });

  it('parentEdges populates WITHOUT controlDeps (data edges only)', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const reads = readsFrom({ 'b#1': ['x'] });
    const root = causalChain(log, 'b#1', reads)!;
    expect(root.parentEdges).toHaveLength(1);
    expect(root.parentEdges[0]).toMatchObject({ kind: 'data', key: 'x', weight: 1.0 });
    expect(root.parentEdges[0].parent).toBe(root.parents[0]);
  });

  it('repeated reads of the same key produce ONE edge (dedup by parent+kind+key)', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const reads = readsFrom({ 'b#1': ['x', 'x', 'x'] });
    const root = causalChain(log, 'b#1', reads)!;
    expect(root.parentEdges).toHaveLength(1);
  });
});

describe('causalChain — compat without controlDeps (legacy behavior pinned)', () => {
  it('diamond topology: parents and linkedBy are unchanged', () => {
    // A writes x,y; B reads x writes p; C reads y writes q; D reads p,q
    const log = [
      commit('a', 'a#0', ['x', 'y'], 0),
      commit('b', 'b#1', ['p'], 1),
      commit('c', 'c#2', ['q'], 2),
      commit('d', 'd#3', ['out'], 3),
    ];
    const reads = readsFrom({ 'b#1': ['x'], 'c#2': ['y'], 'd#3': ['p', 'q'] });

    const root = causalChain(log, 'd#3', reads)!;
    expect(root.parents.map((p) => p.runtimeStageId)).toEqual(['b#1', 'c#2']);
    const a = root.parents[0].parents[0];
    expect(a.runtimeStageId).toBe('a#0');
    expect(a.linkedBy).toBe('x'); // discovery key
    expect(root.parents[1].parents[0]).toBe(a); // shared node

    const text = formatCausalChain(root);
    expect(text).toBe(
      [
        'd (d#3) [wrote: out]',
        '  b (b#1) ← via p [wrote: p]',
        '    a (a#0) ← via x [wrote: x, y]',
        '  c (c#2) ← via q [wrote: q]',
        '    ↳ a#0 (see above)',
      ].join('\n'),
    );
  });
});

describe('formatCausalChain — control edge rendering (D3)', () => {
  it('renders ← [control: label] for control-linked parents', () => {
    const { log, reads, controlDeps } = creditFixture();
    const root = causalChain(log, 'approve#2', reads, { controlDeps })!;
    const text = formatCausalChain(root);
    expect(text).toBe(
      [
        'approve (approve#2) [wrote: status]',
        '  classify (classify#1) ← [control: Good credit]',
        '    pull-bureau (pull-bureau#0) ← via creditScore [wrote: creditScore]',
      ].join('\n'),
    );
  });

  it('renders ← [control] without a label', () => {
    const { log, reads } = creditFixture();
    const controlDeps = controlFrom({ 'approve#2': { deciderId: 'classify#1' } });
    const text = formatCausalChain(causalChain(log, 'approve#2', reads, { controlDeps })!);
    expect(text).toContain('← [control]');
    expect(text).not.toContain('← [control:');
  });

  it('dual-linked parent renders both links: ← via key ← [control: label]', () => {
    const log = [commit('decide', 'decide#0', ['routingNote'], 0), commit('branch', 'branch#1', ['out'], 1)];
    const reads = readsFrom({ 'branch#1': ['routingNote'] });
    const controlDeps = controlFrom({ 'branch#1': { deciderId: 'decide#0', label: 'rule' } });
    const text = formatCausalChain(causalChain(log, 'branch#1', reads, { controlDeps })!);
    expect(text).toContain('← via routingNote ← [control: rule]');
  });
});

describe('causalChain — limits apply to control expansion (D3)', () => {
  it('maxNodes prevents creating the control parent', () => {
    const { log, reads, controlDeps } = creditFixture();
    // Budget of 1 = the root only
    const root = causalChain(log, 'approve#2', reads, { controlDeps, maxNodes: 1 })!;
    expect(root.parents).toHaveLength(0);
    expect(root.parentEdges).toHaveLength(0);
  });

  it('maxDepth stops control expansion past the horizon', () => {
    const log = [
      commit('outer-decide', 'outer-decide#0', [], 0),
      commit('inner-decide', 'inner-decide#1', [], 1),
      commit('leaf', 'leaf#2', ['out'], 2),
    ];
    const controlDeps = controlFrom({
      'leaf#2': { deciderId: 'inner-decide#1' },
      'inner-decide#1': { deciderId: 'outer-decide#0' },
    });
    const root = causalChain(log, 'leaf#2', readsFrom({}), { controlDeps, maxDepth: 1 })!;
    const inner = root.parentEdges[0].parent;
    expect(inner.runtimeStageId).toBe('inner-decide#1');
    // depth 1 node is NOT expanded — outer decider never discovered
    expect(inner.parentEdges).toHaveLength(0);
  });
});
