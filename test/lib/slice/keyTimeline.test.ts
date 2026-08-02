/**
 * keyTimeline — Convention 3 coverage, all 7 types:
 * UNIT, FUNCTIONAL, INTEGRATION, PROPERTY, SECURITY, PERFORMANCE, LOAD.
 *
 * The LAWS being pinned:
 * 1. Commit order, both join keys on every moment (runtimeStageId + commitIdx).
 * 2. A read attributes to the write whose LIVE RANGE it sits in — the same
 *    `(writeIdx, nextWriteIdx]` rule the forward walk uses, including the
 *    read-modify-write boundary. TWO DOORS, ONE TRUTH: a property test pins
 *    timeline attribution against forwardSliceForKey on the same fixture.
 * 3. A read before any write → no `fromWriteIdx` + the pre-run-origin note.
 * 4. The typo guard, shared with the forward walk (bytes pinned there).
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import type { CommitBundle, StageSnapshot, TraceEntry } from '../../../src/lib/memory/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import {
  forwardSliceForKey,
  keysReadFromExecutionTree,
  keysReadFromMap,
  keyTimeline,
} from '../../../src/lib/slice/index.js';
import type { ForwardNode } from '../../../src/lib/slice/types.js';

function commit(
  stageId: string,
  runtimeStageId: string,
  writes: Array<{ key: string; verb?: TraceEntry['verb'] }>,
  idx: number,
): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: writes.map((w): TraceEntry => ({ path: w.key, verb: w.verb ?? 'set' })),
    redactedPaths: [],
    overwrite: Object.fromEntries(writes.map((w) => [w.key, `val-${w.key}`])),
    updates: {},
  };
}

// seed writes k; A reads k; B reads k AND rewrites it; C reads the new k.
const LOG = [
  commit('seed', 'seed#0', [{ key: 'k' }], 0),
  commit('a', 'a#1', [{ key: 'fromA' }], 1),
  commit('b', 'b#2', [{ key: 'k', verb: 'merge' }], 2),
  commit('c', 'c#3', [{ key: 'fromC' }], 3),
];
const READS = keysReadFromMap({ 'a#1': ['k'], 'b#2': ['k'], 'c#3': ['k'] });

// ════════════════════════════════════════════════════════════════════════
// UNIT
// ════════════════════════════════════════════════════════════════════════

describe('keyTimeline — unit', () => {
  it('lists every write and every recorded read in commit order, with both join keys', () => {
    const timeline = keyTimeline(LOG, 'k', READS);
    expect(timeline.moments!.map((m) => `${m.kind}@${m.commitIdx}`)).toEqual([
      'write@0',
      'read@1',
      'read@2',
      'write@2',
      'read@3',
    ]);
    expect(timeline.moments!.every((m) => m.runtimeStageId.length > 0 && Number.isInteger(m.commitIdx))).toBe(true);
    expect(timeline.moments![0]).toMatchObject({ kind: 'write', stageId: 'seed', verb: 'set' });
    expect(timeline.moments![3]).toMatchObject({ kind: 'write', stageId: 'b', verb: 'merge' });
  });

  it('LAW: a read attributes to the live range it sits in — including the read-modify-write boundary', () => {
    const byIdx = new Map(
      keyTimeline(LOG, 'k', READS)
        .moments!.filter((m) => m.kind === 'read')
        .map((m) => [m.commitIdx, m]),
    );
    expect(byIdx.get(1)!.fromWriteIdx).toBe(0);
    // b#2 reads AND rewrites k: its read fired pre-commit → the OLD value.
    expect(byIdx.get(2)!.fromWriteIdx).toBe(0);
    // c#3 reads after the rewrite → the NEW value, never the old one.
    expect(byIdx.get(3)!.fromWriteIdx).toBe(2);
  });

  it('at one commit index the READ moment precedes the WRITE moment (reads fire pre-commit)', () => {
    const moments = keyTimeline(LOG, 'k', READS).moments!;
    const at2 = moments.filter((m) => m.commitIdx === 2).map((m) => m.kind);
    expect(at2).toEqual(['read', 'write']);
  });

  it('LAW: a read before any write has no fromWriteIdx and raises the pre-run-origin note', () => {
    const log = [
      commit('reader', 'reader#0', [{ key: 'other' }], 0),
      commit('writer', 'writer#1', [{ key: 'seeded' }], 1),
    ];
    const timeline = keyTimeline(log, 'seeded', keysReadFromMap({ 'reader#0': ['seeded'] }));
    const read = timeline.moments!.find((m) => m.kind === 'read')!;
    expect(read.fromWriteIdx).toBeUndefined();
    expect(timeline.notes.map((n) => n.code)).toContain('pre-run-origin');
  });

  it('`before` bounds the whole timeline (exclusive, same word as sliceForKey)', () => {
    const timeline = keyTimeline(LOG, 'k', READS, { before: 2 });
    expect(timeline.before).toBe(2);
    expect(timeline.moments!.map((m) => `${m.kind}@${m.commitIdx}`)).toEqual(['write@0', 'read@1']);
  });

  it('honest absence: empty log', () => {
    const timeline = keyTimeline([], 'k', READS);
    expect(timeline.missing).toBe('empty-log');
    expect(timeline.moments).toBeUndefined();
  });

  it('the typo guard is shared with the forward walk (same reason, same note)', () => {
    const timeline = keyTimeline(LOG, 'kk', READS);
    const slice = forwardSliceForKey(LOG, 'kk', READS);
    expect(timeline.missing).toBe('never-written');
    expect(timeline.moments).toBeUndefined();
    expect(timeline.notes).toEqual(slice.notes);
  });

  it('records the keysRead strategy breadcrumb and coverage like every other query', () => {
    expect(keyTimeline(LOG, 'k', READS).keysReadKind).toBe('map');
    const tree: StageSnapshot = {
      id: 'seed',
      runtimeStageId: 'seed#0',
      stageReads: { k: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    };
    expect(keyTimeline(LOG, 'k', keysReadFromExecutionTree(tree)).readsCoverage).toEqual({
      steps: 1,
      stepsWithReads: 1,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — a real run, zero recorders
// ════════════════════════════════════════════════════════════════════════

describe('keyTimeline — functional (real run)', () => {
  interface S {
    recipeId?: string;
    label?: string;
  }

  it('the life of one key across a real chart reads like a story', async () => {
    const chart = flowChart<S>(
      'Seed',
      async (scope) => {
        scope.recipeId = 'r-1';
      },
      'seed',
    )
      .addFunction(
        'Label',
        async (scope) => {
          scope.label = `${scope.recipeId}!`;
        },
        'label',
      )
      .addFunction(
        'Rewrite',
        async (scope) => {
          scope.recipeId = 'r-2';
        },
        'rewrite',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();
    const timeline = keyTimeline(
      snapshot.commitLog,
      'recipeId',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
    );

    expect(timeline.moments!.map((m) => `${m.kind}:${m.stageId}`)).toEqual([
      'write:seed',
      'read:label',
      'write:rewrite',
    ]);
    expect(timeline.moments![1].fromWriteIdx).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION + PROPERTY — TWO DOORS, ONE TRUTH.
// ════════════════════════════════════════════════════════════════════════

describe('keyTimeline — cross-door agreement with forwardSliceForKey', () => {
  function nodesOf(root: ForwardNode): ForwardNode[] {
    const out: ForwardNode[] = [];
    const seen = new Set<ForwardNode>();
    const queue = [root];
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      for (const e of n.fedEdges) queue.push(e.child);
    }
    return out;
  }

  it('INTEGRATION: on a real run, every timeline read sits in the life the walk put it in', async () => {
    const chart = flowChart<{ v?: number; a?: number; b?: number }>(
      'Seed',
      async (scope) => {
        scope.v = 1;
      },
      'seed',
    )
      .addFunction(
        'UseA',
        async (scope) => {
          scope.a = scope.v! + 1;
        },
        'useA',
      )
      .addFunction(
        'Rewrite',
        async (scope) => {
          scope.v = scope.v! * 10;
        },
        'rewrite',
      )
      .addFunction(
        'UseB',
        async (scope) => {
          scope.b = scope.v! + 2;
        },
        'useB',
      )
      .build();

    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const reads = keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot);

    const timeline = keyTimeline(snapshot.commitLog, 'v', reads);
    // Walk every life of `v` (anchor at each write via `before`) and check
    // the reads agree with the timeline's attribution.
    const writes = timeline.moments!.filter((m) => m.kind === 'write').map((m) => m.commitIdx);
    for (const writeIdx of writes) {
      const slice = forwardSliceForKey(snapshot.commitLog, 'v', reads, { before: writeIdx + 1 });
      const walkReads = slice.root!.reads.map((r) => r.commitIdx).sort((x, y) => x - y);
      const timelineReads = timeline
        .moments!.filter((m) => m.kind === 'read' && m.fromWriteIdx === writeIdx)
        .map((m) => m.commitIdx)
        .sort((x, y) => x - y);
      expect(walkReads).toEqual(timelineReads);
    }
  });

  it('PROPERTY: timeline attribution == walk attribution over 20 random logs', () => {
    function mulberry32(seed: number) {
      return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    for (let g = 0; g < 20; g++) {
      const rand = mulberry32(9000 + g);
      const n = 6 + Math.floor(rand() * 14);
      const log: CommitBundle[] = [];
      const readsMap: Record<string, string[]> = {};
      // ONE hot key rewritten repeatedly, plus per-stage private writes —
      // the shape that makes live ranges non-trivial.
      for (let i = 0; i < n; i++) {
        const id = `s${i}#${i}`;
        const writes = [{ key: `own${i}` }];
        if (rand() < 0.4) writes.push({ key: 'hot' });
        log.push(commit(`s${i}`, id, writes, i));
        readsMap[id] = rand() < 0.7 ? ['hot'] : [];
      }
      const reads = keysReadFromMap(readsMap);
      const timeline = keyTimeline(log, 'hot', reads);
      if (!timeline.moments) continue; // 'hot' never appeared in this draw

      for (const moment of timeline.moments) {
        if (moment.kind !== 'read') continue;
        const slice =
          moment.fromWriteIdx === undefined
            ? forwardSliceForKey(log, 'hot', reads, { before: 0 })
            : forwardSliceForKey(log, 'hot', reads, { before: moment.fromWriteIdx + 1 });
        // The life the walk anchored on must contain exactly this read.
        expect(slice.root!.commitIdx).toBe(moment.fromWriteIdx);
        expect(slice.root!.reads.some((r) => r.commitIdx === moment.commitIdx)).toBe(true);
        // …and no OTHER life may claim it.
        const others = nodesOf(slice.root!).filter((nd) => nd.key === 'hot' && nd.commitIdx !== moment.fromWriteIdx);
        expect(others.every((nd) => !nd.reads.some((r) => r.commitIdx === moment.commitIdx))).toBe(true);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECURITY — identity and position only; no values re-served.
// ════════════════════════════════════════════════════════════════════════

describe('keyTimeline — security', () => {
  it('moments carry identity and position, never values (nothing to leak)', () => {
    const redacted: CommitBundle = {
      idx: 0,
      stage: 'auth',
      stageId: 'auth',
      runtimeStageId: 'auth#0',
      trace: [{ path: 'apiKey', verb: 'set' }],
      redactedPaths: ['apiKey'],
      overwrite: { apiKey: '[REDACTED]' },
      updates: {},
    };
    const timeline = keyTimeline([redacted], 'apiKey', keysReadFromMap({}));
    expect(JSON.stringify(timeline)).not.toContain('REDACTED');
    expect(timeline.moments!.map((m) => m.kind)).toEqual(['write']);
  });

  it('a throwing reads provider degrades to writes-only, never crashes', () => {
    const timeline = keyTimeline(LOG, 'k', () => {
      throw new Error('boom');
    });
    expect(timeline.moments!.every((m) => m.kind === 'write')).toBe(true);
    expect(timeline.notes.some((n) => n.code === 'reads-not-recorded')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PERFORMANCE + LOAD
// ════════════════════════════════════════════════════════════════════════

describe('keyTimeline — performance & load', () => {
  it('perf: the timeline of a hot key over a 5k-commit log stays under 300ms', () => {
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < 5000; i++) {
      const id = `s${i}#${i}`;
      log.push(commit(`s${i}`, id, i % 50 === 0 ? [{ key: 'hot' }] : [{ key: `own${i}` }], i));
      readsMap[id] = ['hot'];
    }
    const t0 = performance.now();
    const timeline = keyTimeline(log, 'hot', keysReadFromMap(readsMap));
    const elapsed = performance.now() - t0;
    expect(timeline.moments!.length).toBe(5000 + 100); // 5000 reads + 100 writes
    expect(elapsed).toBeLessThan(300);
  });

  it('load: 200 timelines over a 1k-commit log under 3s', () => {
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < 1000; i++) {
      const id = `s${i}#${i}`;
      log.push(commit(`s${i}`, id, [{ key: `k${i % 200}` }], i));
      readsMap[id] = i > 0 ? [`k${(i - 1) % 200}`] : [];
    }
    const reads = keysReadFromMap(readsMap);
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) keyTimeline(log, `k${k}`, reads);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
