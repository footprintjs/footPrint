/**
 * causalChain edgeAttribution: 'per-write' (#P1) — the refinement that
 * per-write read provenance (TraceEntry.readKeys) buys.
 *
 * What is being pinned:
 * 1. THE core claim: a stage reading `a,b` and writing `x,y` no longer makes
 *    the slice for x depend on b (per-write) — while 'stage' mode keeps the
 *    coarse ceiling (both). This is the honest-edges upgrade.
 * 2. The WORKLIST: a node linked via multiple written keys accumulates the
 *    union of those writes' read-sets incrementally (monotone, terminating).
 * 3. HONEST FALLBACK: logs without readKeys behave byte-identically to
 *    'stage' mode — mixed logs degrade per-node, never silently narrow.
 * 4. SAFETY property: the per-write slice is always a SUBSET of the
 *    stage-level slice (it refines, never invents).
 * 5. End-to-end: executor dial → sliceForKey default 'per-write'.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { type CausalNode, causalChain, flattenCausalDAG } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle, StageSnapshot, TraceEntry } from '../../../src/lib/memory/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import { keysReadFromExecutionTree, sliceForKey } from '../../../src/lib/slice/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

function commit(
  stageId: string,
  runtimeStageId: string,
  writes: Array<{ key: string; readKeys?: string[] }>,
  idx: number,
): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: writes.map(
      (w): TraceEntry => ({ path: w.key, verb: 'set', ...(w.readKeys !== undefined && { readKeys: w.readKeys }) }),
    ),
    redactedPaths: [],
    overwrite: Object.fromEntries(writes.map((w) => [w.key, `val-${w.key}`])),
    updates: {},
  };
}

function ids(root: CausalNode): Set<string> {
  return new Set(flattenCausalDAG(root).map((n) => n.runtimeStageId));
}

// The canonical fixture: writerA writes a; writerB writes b; M reads a,b and
// writes x (from a only) and y (from a AND b); top reads x.
const LOG = [
  commit('writerA', 'writerA#0', [{ key: 'a', readKeys: [] }], 0),
  commit('writerB', 'writerB#1', [{ key: 'b', readKeys: [] }], 1),
  commit(
    'mixed',
    'mixed#2',
    [
      { key: 'x', readKeys: ['a'] }, // x written after reading only a
      { key: 'y', readKeys: ['a', 'b'] }, // y written after reading both
    ],
    2,
  ),
  commit('top', 'top#3', [{ key: 'result', readKeys: ['x'] }], 3),
];
const STAGE_READS: Record<string, string[]> = {
  'writerA#0': [],
  'writerB#1': [],
  'mixed#2': ['a', 'b'],
  'top#3': ['x'],
};
const lookup = (id: string) => STAGE_READS[id] ?? [];

// ════════════════════════════════════════════════════════════════════════
// UNIT — the core refinement + fallback + worklist
// ════════════════════════════════════════════════════════════════════════

describe('edgeAttribution per-write — unit', () => {
  it("THE claim: slicing x through 'mixed' excludes b's writer; 'stage' mode includes it", () => {
    const perWrite = causalChain(LOG, 'top#3', lookup, {
      edgeAttribution: 'per-write',
      rootLinkKeys: ['result'],
    })!;
    // result←x←(mixed's x-write read only a)←writerA. writerB must NOT appear.
    expect(ids(perWrite)).toEqual(new Set(['top#3', 'mixed#2', 'writerA#0']));

    const stage = causalChain(LOG, 'top#3', lookup)!;
    // Stage-level ceiling: mixed expands through ALL its reads → b included.
    expect(ids(stage)).toEqual(new Set(['top#3', 'mixed#2', 'writerA#0', 'writerB#1']));
  });

  it('slicing y (which really read both) keeps both writers under per-write', () => {
    const log = [...LOG.slice(0, 3), commit('topY', 'topY#3', [{ key: 'r2', readKeys: ['y'] }], 3)];
    const dag = causalChain(log, 'topY#3', (id) => (id === 'topY#3' ? ['y'] : STAGE_READS[id] ?? []), {
      edgeAttribution: 'per-write',
      rootLinkKeys: ['r2'],
    })!;
    expect(ids(dag)).toEqual(new Set(['topY#3', 'mixed#2', 'writerA#0', 'writerB#1']));
  });

  it('WORKLIST: a node linked via two keys accumulates both read-sets incrementally', () => {
    // P writes x (read a) and y (read b). Root reads BOTH x and y → P is
    // first linked via one key, then re-expanded via the other.
    const log = [
      commit('wa', 'wa#0', [{ key: 'a', readKeys: [] }], 0),
      commit('wb', 'wb#1', [{ key: 'b', readKeys: [] }], 1),
      commit(
        'P',
        'P#2',
        [
          { key: 'x', readKeys: ['a'] },
          { key: 'y', readKeys: ['b'] },
        ],
        2,
      ),
      commit('root', 'root#3', [{ key: 'r', readKeys: ['x', 'y'] }], 3),
    ];
    const dag = causalChain(log, 'root#3', (id) => (id === 'root#3' ? ['x', 'y'] : id === 'P#2' ? ['a', 'b'] : []), {
      edgeAttribution: 'per-write',
      rootLinkKeys: ['r'],
    })!;
    // Both grandparents present — the second link's delta re-expanded P.
    expect(ids(dag)).toEqual(new Set(['root#3', 'P#2', 'wa#0', 'wb#1']));
  });

  it('HONEST FALLBACK: entries without readKeys expand at stage level (identical to stage mode)', () => {
    const bare = LOG.map((b) => ({
      ...b,
      trace: b.trace.map(({ path, verb }) => ({ path, verb })), // strip readKeys
    }));
    const perWrite = causalChain(bare, 'top#3', lookup, { edgeAttribution: 'per-write', rootLinkKeys: ['result'] })!;
    const stage = causalChain(bare, 'top#3', lookup)!;
    expect(ids(perWrite)).toEqual(ids(stage)); // degrade to ceiling, never narrower
  });

  it('empty readKeys ([]) is information: the write depended on NO tracked reads → leaf', () => {
    const dag = causalChain(LOG, 'writerA#0', lookup, { edgeAttribution: 'per-write', rootLinkKeys: ['a'] })!;
    expect(dag.parents).toHaveLength(0); // [] ≠ absent: no fallback, honest leaf
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROPERTY — refinement safety: per-write ⊆ stage-level, for random graphs
// ════════════════════════════════════════════════════════════════════════

describe('edgeAttribution per-write — property (subset of the stage-level ceiling)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds over 25 random provenance graphs', () => {
    for (let run = 0; run < 25; run++) {
      const rand = mulberry32(500 + run);
      const n = 6 + Math.floor(rand() * 12);
      const log: CommitBundle[] = [];
      const stageReads: Record<string, string[]> = {};
      for (let i = 0; i < n; i++) {
        const id = `s${i}#${i}`;
        // Each stage reads up to 3 earlier keys...
        const reads = [...new Set(Array.from({ length: 3 }, () => `k${Math.floor(rand() * Math.max(1, i))}`))].filter(
          () => i > 0 && rand() < 0.8,
        );
        stageReads[id] = reads;
        // ...and writes its key with a RANDOM SUBSET of those reads as the
        // per-write prefix (some entries randomly omit readKeys → fallback).
        const prefix = rand() < 0.2 ? undefined : reads.filter(() => rand() < 0.6);
        log.push(commit(`s${i}`, id, [{ key: `k${i}`, ...(prefix !== undefined && { readKeys: prefix }) }], i));
      }
      const startId = `s${n - 1}#${n - 1}`;
      const lookupR = (id: string) => stageReads[id] ?? [];
      const opts = { maxDepth: 100, maxNodes: 1000 };
      const refined = causalChain(log, startId, lookupR, {
        ...opts,
        edgeAttribution: 'per-write',
        rootLinkKeys: [`k${n - 1}`],
      })!;
      const ceiling = causalChain(log, startId, lookupR, opts)!;
      const refinedIds = ids(refined);
      const ceilingIds = ids(ceiling);
      for (const id of refinedIds) {
        expect(ceilingIds.has(id), `run ${run}: ${id} in refined but not ceiling`).toBe(true);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL / INTEGRATION — the dial + sliceForKey end-to-end
// ════════════════════════════════════════════════════════════════════════

describe('per-write end-to-end — dial → sliceForKey', () => {
  interface S {
    a?: number;
    b?: number;
    x?: number;
    y?: number;
  }

  function mixedChart() {
    return flowChart<S>(
      'WriteA',
      async (scope) => {
        scope.a = 1;
      },
      'write-a',
    )
      .addFunction(
        'WriteB',
        async (scope) => {
          scope.b = 2;
        },
        'write-b',
      )
      .addFunction(
        'Mixed',
        async (scope) => {
          scope.x = scope.a! * 10; // x's prefix: [a]
          scope.y = scope.a! + scope.b!; // y's prefix: [a, b]
        },
        'mixed',
      )
      .build();
  }

  it('with the dial: slice for x excludes b entirely; slice for y includes it', async () => {
    const executor = new FlowChartExecutor(mixedChart(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snap = executor.getSnapshot();
    const reads = keysReadFromExecutionTree(snap.executionTree as StageSnapshot);

    const xSlice = sliceForKey(snap.commitLog, 'x', reads); // defaults to per-write
    const xIds = [...ids(xSlice.root!)];
    expect(xIds.some((id) => id.startsWith('write-a#'))).toBe(true);
    expect(xIds.some((id) => id.startsWith('write-b#'))).toBe(false); // the refinement

    const ySlice = sliceForKey(snap.commitLog, 'y', reads);
    const yIds = [...ids(ySlice.root!)];
    expect(yIds.some((id) => id.startsWith('write-b#'))).toBe(true);
  });

  it('without the dial: same query degrades to the stage-level ceiling (x appears to depend on b)', async () => {
    const executor = new FlowChartExecutor(mixedChart());
    await executor.run();
    const snap = executor.getSnapshot();
    const xSlice = sliceForKey(snap.commitLog, 'x', keysReadFromExecutionTree(snap.executionTree as StageSnapshot));
    expect([...ids(xSlice.root!)].some((id) => id.startsWith('write-b#'))).toBe(true); // honest ceiling
  });
});
