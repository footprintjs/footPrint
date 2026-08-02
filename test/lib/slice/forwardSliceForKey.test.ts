/**
 * forwardSliceForKey — Convention 3 coverage, all 7 types:
 * UNIT, FUNCTIONAL, INTEGRATION, PROPERTY, SECURITY, PERFORMANCE, LOAD.
 *
 * The LAWS being pinned (each has its own test):
 * 1. LIVE RANGE `(writeIdx, nextWriteIdx]` — a read after the next write
 *    attributes to the NEW write, never the old; a read-modify-write stage's
 *    own read belongs to the PREVIOUS life (reads fire pre-commit).
 * 2. `fed` edges are EXACT only under recorded `readKeys` — the dial off
 *    stamps every edge conservative AND adds the slice-level note; recorded
 *    provenance also EXCLUDES exactly. Never conservative-presented-as-exact.
 * 3. Budget truncation is STATED (root.truncated + a 'truncated' note).
 * 4. The typo guard, split by what the recording affords: a typo and a
 *    genuinely-seeded-but-unread key are distinguishable whenever reads were
 *    recorded — with the refusal bytes (bounded known-keys list) pinned.
 * 5. Key normalisation goes through the shipped `normaliseStateKey`, so both
 *    doors accept identical inputs.
 * 6. Both writeProvenance dial states are verified against REAL runs.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import type { CommitBundle, StageSnapshot, TraceEntry } from '../../../src/lib/memory/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import {
  forwardSliceForKey,
  keysReadFromExecutionTree,
  keysReadFromMap,
  sliceForKey,
} from '../../../src/lib/slice/index.js';
import type { ForwardNode } from '../../../src/lib/slice/types.js';

// ── Test helpers ───────────────────────────────────────────────────────

function commit(
  stageId: string,
  runtimeStageId: string,
  writes: Array<{ key: string; readKeys?: string[]; verb?: TraceEntry['verb'] }>,
  idx: number,
): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: writes.map(
      (w): TraceEntry => ({
        path: w.key,
        verb: w.verb ?? 'set',
        ...(w.readKeys !== undefined && { readKeys: w.readKeys }),
      }),
    ),
    redactedPaths: [],
    overwrite: Object.fromEntries(writes.map((w) => [w.key, `val-${w.key}`])),
    updates: {},
  };
}

/** Every node of a forward slice, BFS, each once. */
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

// ════════════════════════════════════════════════════════════════════════
// UNIT — the walk, the live range, the anchor
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — unit', () => {
  // seed writes k; A reads k; B REWRITES k; C reads k (the new one).
  const LOG = [
    commit('seed', 'seed#0', [{ key: 'k' }], 0),
    commit('a', 'a#1', [{ key: 'fromA' }], 1),
    commit('b', 'b#2', [{ key: 'k' }], 2),
    commit('c', 'c#3', [{ key: 'fromC' }], 3),
  ];
  const READS = keysReadFromMap({ 'a#1': ['k'], 'b#2': ['k'], 'c#3': ['k'] });

  it('anchors at the LAST write of the key (mirror of sliceForKey)', () => {
    const fwd = forwardSliceForKey(LOG, 'k', READS);
    expect(fwd.writer?.runtimeStageId).toBe('b#2');
    expect(fwd.root?.origin).toBe('write');
    expect(fwd.root?.runtimeStageId).toBe('b#2');
    expect(fwd.missing).toBeUndefined();
  });

  it("LAW 1: the live range ends at the key's next write — a later read attributes to the NEW write", () => {
    // Anchor at the FIRST write via `before`: c#3's read is AFTER b#2's
    // rewrite, so it must NOT appear in seed#0's life.
    const first = forwardSliceForKey(LOG, 'k', READS, { before: 2 });
    expect(first.root!.runtimeStageId).toBe('seed#0');
    expect(first.root!.nextWriteIdx).toBe(2);
    expect(first.root!.reads.map((r) => r.runtimeStageId)).toEqual(['a#1', 'b#2']);
    // …and it DOES appear in the later life.
    const second = forwardSliceForKey(LOG, 'k', READS);
    expect(second.root!.reads.map((r) => r.runtimeStageId)).toEqual(['c#3']);
  });

  it("LAW 1 (read-modify-write): the rewriting stage's own read belongs to the PREVIOUS life", () => {
    // b#2 both reads k and writes k. Its read fires pre-commit → it saw the
    // OLD value, so it sits in seed#0's life and starts a new one itself.
    const first = forwardSliceForKey(LOG, 'k', READS, { before: 2 });
    expect(first.root!.reads.some((r) => r.runtimeStageId === 'b#2')).toBe(true);
    const second = forwardSliceForKey(LOG, 'k', READS);
    expect(second.root!.runtimeStageId).toBe('b#2');
    expect(second.root!.reads.some((r) => r.runtimeStageId === 'b#2')).toBe(false);
    // The old life FED the new one (same key, next write).
    const fedKeys = first.root!.fedEdges.map((e) => `${e.child.key}@${e.child.commitIdx}`);
    expect(fedKeys).toContain('k@2');
  });

  it("a reading stage's writes become fed edges, and the walk descends into them", () => {
    const log = [
      commit('seed', 'seed#0', [{ key: 'a' }], 0),
      commit('mid', 'mid#1', [{ key: 'b' }], 1),
      commit('leaf', 'leaf#2', [{ key: 'c' }], 2),
    ];
    const fwd = forwardSliceForKey(log, 'a', keysReadFromMap({ 'mid#1': ['a'], 'leaf#2': ['b'] }));
    const chain = nodesOf(fwd.root!).map((n) => n.key);
    expect(chain).toEqual(['a', 'b', 'c']);
    expect(fwd.root!.fedEdges[0].child.depth).toBe(1);
  });

  it('`before` bounds the ANCHOR only — the walk still runs forward past it', () => {
    const fwd = forwardSliceForKey(LOG, 'k', READS, { before: 2 });
    // Reads at commit 2 (>= before) are still walked: the value lived there.
    expect(fwd.root!.reads.some((r) => r.commitIdx === 2)).toBe(true);
    expect(fwd.before).toBe(2);
  });

  it('honest absence: empty log', () => {
    const fwd = forwardSliceForKey([], 'k', READS);
    expect(fwd.missing).toBe('empty-log');
    expect(fwd.root).toBeUndefined();
    expect(fwd.notes).toEqual([]);
  });

  it('records which keysRead strategy produced the answer', () => {
    expect(forwardSliceForKey(LOG, 'k', READS).keysReadKind).toBe('map');
    expect(forwardSliceForKey(LOG, 'k', () => ['k']).keysReadKind).toBe('custom-fn');
  });

  it('LAW 5: a path-array key normalises exactly as the backward door normalises it', () => {
    const nested = ['customer', 'address'];
    const log = [commit('w', 'w#0', [{ key: 'x' }], 0)];
    const fwd = forwardSliceForKey(log, nested, keysReadFromMap({}));
    const back = sliceForKey(log, nested, keysReadFromMap({}));
    expect(fwd.key).toBe(back.key);
    // Same input, same normalised key, whichever door you knock on.
    expect(forwardSliceForKey(log, 'x', keysReadFromMap({})).key).toBe(sliceForKey(log, 'x', keysReadFromMap({})).key);
  });
});

// ════════════════════════════════════════════════════════════════════════
// UNIT — LAW 2: exact vs conservative fed edges
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — fed-edge attribution (LAW 2)', () => {
  // M reads a,b and writes x (from a only) and y (from a AND b).
  const LOG_WITH_PROVENANCE = [
    commit('wa', 'wa#0', [{ key: 'a', readKeys: [] }], 0),
    commit('wb', 'wb#1', [{ key: 'b', readKeys: [] }], 1),
    commit(
      'mixed',
      'mixed#2',
      [
        { key: 'x', readKeys: ['a'] },
        { key: 'y', readKeys: ['a', 'b'] },
      ],
      2,
    ),
  ];
  const READS = keysReadFromMap({ 'mixed#2': ['a', 'b'] });

  it('recorded readKeys make edges EXACT — and exclude exactly', () => {
    const fromB = forwardSliceForKey(LOG_WITH_PROVENANCE, 'b', READS);
    // b fed y only; x's write recorded that it had read only `a`.
    expect(fromB.root!.fedEdges.map((e) => e.child.key)).toEqual(['y']);
    expect(fromB.root!.fedEdges[0].basis).toBe('per-write');
    expect(fromB.notes.some((n) => n.code === 'conservative-fed-edges')).toBe(false);

    const fromA = forwardSliceForKey(LOG_WITH_PROVENANCE, 'a', READS);
    expect(fromA.root!.fedEdges.map((e) => e.child.key).sort()).toEqual(['x', 'y']);
  });

  it('dial OFF: every fed edge is stamped conservative AND the slice says so', () => {
    const dialOff = LOG_WITH_PROVENANCE.map((b) => ({
      ...b,
      trace: b.trace.map(({ path, verb }) => ({ path, verb })),
    }));
    const fromB = forwardSliceForKey(dialOff, 'b', READS);
    // Stage-level co-occurrence keeps BOTH writes as candidates (the honest
    // over-approximation) …
    expect(fromB.root!.fedEdges.map((e) => e.child.key).sort()).toEqual(['x', 'y']);
    // … every one of them labeled, and the slice-level note present.
    expect(fromB.root!.fedEdges.every((e) => e.basis === 'stage')).toBe(true);
    const note = fromB.notes.find((n) => n.code === 'conservative-fed-edges');
    expect(note).toBeDefined();
    expect(note!.detail).toContain('CONSERVATIVE');
    expect(note!.detail).toContain("writeProvenance: 'reads-prefix'");
  });

  it('a conservative edge is NEVER presented as exact (mixed log degrades per edge)', () => {
    // One write carries provenance, the other does not.
    const mixed = [
      commit('wa', 'wa#0', [{ key: 'a', readKeys: [] }], 0),
      commit('p', 'p#1', [{ key: 'x', readKeys: ['a'] }], 1),
      commit('q', 'q#2', [{ key: 'z' }], 2), // no readKeys
    ];
    const fwd = forwardSliceForKey(mixed, 'a', keysReadFromMap({ 'p#1': ['a'], 'q#2': ['a'] }));
    const byKey = Object.fromEntries(fwd.root!.fedEdges.map((e) => [e.child.key, e.basis]));
    expect(byKey).toEqual({ x: 'per-write', z: 'stage' });
    expect(fwd.notes.some((n) => n.code === 'conservative-fed-edges')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// UNIT — LAW 4 (the typo guard) + LAW 3 (truncation is stated)
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — honest absence and budgets', () => {
  const LOG = [commit('seed', 'seed#0', [{ key: 'recipeId' }], 0), commit('use', 'use#1', [{ key: 'total' }], 1)];
  const READS = keysReadFromMap({ 'use#1': ['recipeId'] });

  it('LAW 4: a typo is NAMED as unknown, with the bounded known-keys list (bytes pinned)', () => {
    const fwd = forwardSliceForKey(LOG, 'recipId', READS);
    expect(fwd.missing).toBe('never-written');
    expect(fwd.root).toBeUndefined();
    expect(fwd.notes).toHaveLength(1);
    expect(fwd.notes[0]).toEqual({
      code: 'unknown-key',
      detail:
        "unknown key 'recipId' — this commit log has no write and no recorded read of it. " +
        'Known keys: recipeId, total. ' +
        'If the key is real, check that the commit log and the reads provider come from the SAME scope ' +
        '(a subflow has its own).',
    });
  });

  it('LAW 4: the known-keys list is BOUNDED (10 + a count), never a wall', () => {
    const wide = [
      commit(
        'w',
        'w#0',
        Array.from({ length: 40 }, (_, i) => ({ key: `k${String(i).padStart(2, '0')}` })),
        0,
      ),
    ];
    const note = forwardSliceForKey(wide, 'nope', keysReadFromMap({ 'w#0': ['k00'] })).notes[0];
    expect(note.detail).toContain('k00, k01, k02, k03, k04, k05, k06, k07, k08, k09 (+30 more)');
    expect(note.detail).not.toContain('k10,');
  });

  it('LAW 4: a typo and a genuinely-seeded-but-unread key are DISTINGUISHABLE when reads were recorded', () => {
    // `seededUnread` is never written and never read — same as a typo, and
    // honestly reported as such: the log can see readers, and it has none.
    const typo = forwardSliceForKey(LOG, 'recipId', READS);
    const seededUnread = forwardSliceForKey(LOG, 'seededButUnread', READS);
    expect(typo.missing).toBe('never-written');
    expect(seededUnread.missing).toBe('never-written');
    // The distinguishable case: a seeded key that WAS read gets a real
    // pre-run life instead of an absence.
    const seededAndRead = forwardSliceForKey(LOG, 'seedIn', keysReadFromMap({ 'use#1': ['seedIn'] }));
    expect(seededAndRead.missing).toBeUndefined();
    expect(seededAndRead.root!.origin).toBe('pre-run');
    expect(seededAndRead.root!.runtimeStageId).toBeUndefined();
    expect(seededAndRead.root!.reads.map((r) => r.runtimeStageId)).toEqual(['use#1']);
    expect(seededAndRead.notes.map((n) => n.code)).toContain('pre-run-origin');
  });

  it('LAW 4 (the other half): with NO recorded reads, the pre-run life MUST carry the reads-not-recorded note', () => {
    // readTracking off → a typo and an unread seeded key are genuinely
    // indistinguishable; the answer must not imply "unread".
    const blind = forwardSliceForKey(LOG, 'recipId', keysReadFromMap({}));
    expect(blind.missing).toBeUndefined();
    expect(blind.root!.origin).toBe('pre-run');
    const codes = blind.notes.map((n) => n.code);
    expect(codes).toContain('unknown-key');
    expect(codes).toContain('reads-not-recorded');
    expect(blind.notes.find((n) => n.code === 'reads-not-recorded')!.detail).toContain('UNKNOWABLE');
  });

  it('LAW 3: a node budget cut is stated on the root AND as a note', () => {
    const log = [commit('seed', 'seed#0', [{ key: 'k0' }], 0)];
    const reads: Record<string, string[]> = {};
    for (let i = 1; i <= 10; i++) {
      log.push(commit(`s${i}`, `s${i}#${i}`, [{ key: `k${i}` }], i));
      reads[`s${i}#${i}`] = [`k${i - 1}`];
    }
    const fwd = forwardSliceForKey(log, 'k0', keysReadFromMap(reads), { maxNodes: 3 });
    expect(fwd.root!.truncated).toEqual({ byDepth: false, byNodes: true });
    const note = fwd.notes.find((n) => n.code === 'truncated');
    expect(note!.detail).toContain('maxNodes reached');
    expect(nodesOf(fwd.root!)).toHaveLength(3);
  });

  it('LAW 3: a depth budget cut is stated too', () => {
    const log = [commit('seed', 'seed#0', [{ key: 'k0' }], 0)];
    const reads: Record<string, string[]> = {};
    for (let i = 1; i <= 6; i++) {
      log.push(commit(`s${i}`, `s${i}#${i}`, [{ key: `k${i}` }], i));
      reads[`s${i}#${i}`] = [`k${i - 1}`];
    }
    const fwd = forwardSliceForKey(log, 'k0', keysReadFromMap(reads), { maxDepth: 2 });
    expect(fwd.root!.truncated).toEqual({ byDepth: true, byNodes: false });
    expect(fwd.notes.some((n) => n.code === 'truncated')).toBe(true);
  });

  it('an untouched budget leaves NO truncation flag and NO note', () => {
    const fwd = forwardSliceForKey(LOG, 'recipeId', READS);
    expect(fwd.root!.truncated).toBeUndefined();
    expect(fwd.notes.some((n) => n.code === 'truncated')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — a real run, both writeProvenance dial states (LAW 6)
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — functional (real run, dial ON and OFF)', () => {
  interface S {
    recipeId?: string;
    servings?: number;
    ingredients?: string[];
    shoppingList?: string[];
  }

  const chart = flowChart<S>(
    'Seed',
    async (scope) => {
      scope.recipeId = 'r-42';
      scope.servings = 2;
    },
    'seed',
  )
    .addFunction(
      'Lookup',
      async (scope) => {
        scope.ingredients = [`flour(${scope.recipeId})`, 'water'];
      },
      'lookup',
    )
    .addFunction(
      'Scale',
      async (scope) => {
        scope.shoppingList = scope.ingredients!.map((i) => `${i} x${scope.servings}`);
      },
      'scale',
    )
    .build();

  async function runWith(writeProvenance?: 'reads-prefix') {
    const executor = new FlowChartExecutor(chart, writeProvenance ? { writeProvenance } : {});
    await executor.run();
    const snapshot = executor.getSnapshot();
    return {
      slice: forwardSliceForKey(
        snapshot.commitLog,
        'recipeId',
        keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
      ),
    };
  }

  it("dial ON: 'who read recipeId and what did it feed' answers in ONE query, exactly", async () => {
    const { slice } = await runWith('reads-prefix');
    expect(slice.root!.stageId).toBe('seed');
    expect(slice.root!.reads.map((r) => r.stageId)).toEqual(['lookup']);
    expect(slice.root!.fedEdges.map((e) => e.child.key)).toEqual(['ingredients']);
    expect(slice.root!.fedEdges[0].basis).toBe('per-write');
    // …and the walk continues: ingredients fed shoppingList.
    const grandchild = slice.root!.fedEdges[0].child.fedEdges[0];
    expect(grandchild.child.key).toBe('shoppingList');
    expect(grandchild.basis).toBe('per-write');
    expect(slice.notes.some((n) => n.code === 'conservative-fed-edges')).toBe(false);
  });

  it('dial OFF: the same walk, every edge labeled conservative + one slice-level note', async () => {
    const { slice } = await runWith();
    expect(slice.root!.reads.map((r) => r.stageId)).toEqual(['lookup']);
    expect(slice.root!.fedEdges.map((e) => e.child.key)).toEqual(['ingredients']);
    expect(slice.root!.fedEdges.every((e) => e.basis === 'stage')).toBe(true);
    expect(slice.notes.filter((n) => n.code === 'conservative-fed-edges')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — the loop chart (a value re-read every iteration) and the
// backward door: forward and backward must agree on the same edge.
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — integration', () => {
  interface S {
    seedValue?: number;
    total?: number;
    count?: number;
  }

  it('a loop re-reads one value: every iteration shows up as a read of the SAME life', async () => {
    const chart = flowChart<S>(
      'Seed',
      async (scope) => {
        scope.seedValue = 3;
        scope.total = 0;
        scope.count = 0;
      },
      'seed',
    )
      .addFunction(
        'Accumulate',
        async (scope) => {
          scope.total = (scope.total ?? 0) + scope.seedValue!;
          scope.count = (scope.count ?? 0) + 1;
        },
        'accumulate',
      )
      .addDeciderFunction('More', async (scope) => (scope.count! < 3 ? 'again' : 'done'), 'more')
      .addFunctionBranch(
        'again',
        'Loop',
        async () => {
          /* hop back */
        },
        undefined,
        { loopTo: 'accumulate' },
      )
      .addFunctionBranch('done', 'Finish', async () => {})
      .setDefault('done')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const slice = forwardSliceForKey(
      snapshot.commitLog,
      'seedValue',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
    );

    // seedValue is written once and never rewritten — ONE life, read by
    // every accumulate iteration.
    expect(slice.root!.nextWriteIdx).toBeUndefined();
    expect(slice.root!.reads.filter((r) => r.stageId === 'accumulate')).toHaveLength(3);
    // and each iteration's read fed that iteration's `total` write.
    const fedTotals = slice.root!.fedEdges.filter((e) => e.child.key === 'total');
    expect(fedTotals).toHaveLength(3);
    expect(fedTotals.every((e) => e.basis === 'per-write')).toBe(true);
  });

  it("forward and backward agree: if A fed B, then B's backward slice contains A", async () => {
    const chart = flowChart<{ a?: string; b?: string; c?: string }>(
      'A',
      async (scope) => {
        scope.a = 'a';
      },
      'a',
    )
      .addFunction(
        'B',
        async (scope) => {
          scope.b = `${scope.a}b`;
        },
        'b',
      )
      .addFunction(
        'C',
        async (scope) => {
          scope.c = `${scope.b}c`;
        },
        'c',
      )
      .build();

    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const reads = keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot);

    const forward = forwardSliceForKey(snapshot.commitLog, 'a', reads);
    for (const node of nodesOf(forward.root!)) {
      if (node.key === 'a') continue;
      const backward = sliceForKey(snapshot.commitLog, node.key, reads);
      const ancestors = new Set<string>();
      const stack = [backward.root!];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (ancestors.has(n.runtimeStageId)) continue;
        ancestors.add(n.runtimeStageId);
        for (const p of n.parents) stack.push(p);
      }
      expect([...ancestors].some((id) => id.startsWith('a#'))).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROPERTY — the forward walk is the REVERSE of the backward one: for
// random graphs, "X is in the forward slice of k" iff "k's writer is in the
// backward slice of X's key at X's commit".
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — property (forward/backward duality)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('every fed edge matches an independent forward-reachability computation (20 random graphs)', () => {
    for (let g = 0; g < 20; g++) {
      const rand = mulberry32(4000 + g);
      const n = 5 + Math.floor(rand() * 15);
      const log: CommitBundle[] = [];
      const readsMap: Record<string, string[]> = {};
      for (let i = 0; i < n; i++) {
        const id = `s${i}#${i}`;
        const reads: string[] = [];
        for (let r = 0; r < 2; r++) {
          if (i > 0 && rand() < 0.7) reads.push(`k${Math.floor(rand() * i)}`);
        }
        readsMap[id] = [...new Set(reads)];
        log.push(commit(`s${i}`, id, [{ key: `k${i}` }], i));
      }
      const fwd = forwardSliceForKey(log, 'k0', keysReadFromMap(readsMap), { maxDepth: 100, maxNodes: 1000 });

      // Reference: forward BFS over (write → readers in its live range →
      // their writes). Every key here is written exactly once, so a life is
      // "from its write to the end of the log".
      const expected = new Set<string>(['k0@0']);
      const queue: Array<[string, number]> = [['k0', 0]];
      while (queue.length > 0) {
        const [key, at] = queue.shift()!;
        for (let r = at + 1; r < n; r++) {
          if (!readsMap[`s${r}#${r}`].includes(key)) continue;
          const childKey = `k${r}`;
          const tag = `${childKey}@${r}`;
          if (expected.has(tag)) continue;
          expected.add(tag);
          queue.push([childKey, r]);
        }
      }

      const got = new Set(nodesOf(fwd.root!).map((node) => `${node.key}@${node.commitIdx}`));
      expect(got).toEqual(expected);
    }
  });

  it('the walk always terminates and never revisits a life (visited-set guard)', () => {
    // A dense log where every stage reads every earlier key.
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < 25; i++) {
      const id = `s${i}#${i}`;
      readsMap[id] = Array.from({ length: i }, (_, j) => `k${j}`);
      log.push(commit(`s${i}`, id, [{ key: `k${i}` }], i));
    }
    const fwd = forwardSliceForKey(log, 'k0', keysReadFromMap(readsMap), { maxDepth: 100, maxNodes: 1000 });
    const nodes = nodesOf(fwd.root!);
    expect(new Set(nodes.map((nd) => `${nd.key}@${nd.commitIdx}`)).size).toBe(nodes.length);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECURITY — this layer re-serves commit-log bytes; redacted stays redacted,
// and a hostile reads provider cannot break the query.
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — security', () => {
  it('a redacted writer bundle flows through unmodified — no resurrection surface', () => {
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
    const use = commit('use', 'use#1', [{ key: 'header' }], 1);
    const fwd = forwardSliceForKey([redacted, use], 'apiKey', keysReadFromMap({ 'use#1': ['apiKey'] }));
    expect(fwd.writer!.overwrite.apiKey).toBe('[REDACTED]');
    // The forward node carries identity and position — never values.
    expect(JSON.stringify(fwd.root)).not.toContain('REDACTED');
    expect(JSON.stringify(fwd.root)).not.toContain('sk-real');
  });

  it('a reads provider that THROWS degrades to "no recorded reads", never crashes the query', () => {
    const log = [commit('a', 'a#0', [{ key: 'k' }], 0), commit('b', 'b#1', [{ key: 'z' }], 1)];
    const hostile = () => {
      throw new Error('provider exploded');
    };
    const fwd = forwardSliceForKey(log, 'k', hostile);
    expect(fwd.root!.reads).toEqual([]);
    expect(fwd.notes.some((n) => n.code === 'reads-not-recorded')).toBe(true);
  });

  it('a prototype-shaped key cannot reach through Object.prototype', () => {
    const log = [commit('a', 'a#0', [{ key: 'k' }], 0)];
    const fwd = forwardSliceForKey(log, 'constructor', keysReadFromMap({ 'a#0': ['k'] }));
    expect(fwd.missing).toBe('never-written');
    expect(fwd.notes[0].code).toBe('unknown-key');
  });
});

// ════════════════════════════════════════════════════════════════════════
// PERFORMANCE + LOAD — post-hoc query budgets (CI-safe, generous).
// ════════════════════════════════════════════════════════════════════════

describe('forwardSliceForKey — performance & load', () => {
  function chainLog(n: number) {
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) {
      const id = `s${i}#${i}`;
      log.push(commit(`s${i}`, id, [{ key: `k${i}` }], i));
      readsMap[id] = i > 0 ? [`k${i - 1}`] : [];
    }
    return { log, readsMap };
  }

  it('perf: one forward slice over a 5k-commit log stays under 500ms', () => {
    const { log, readsMap } = chainLog(5000);
    const reads = keysReadFromMap(readsMap);
    const t0 = performance.now();
    const fwd = forwardSliceForKey(log, 'k0', reads, { maxDepth: 50 });
    const elapsed = performance.now() - t0;
    expect(fwd.root).toBeDefined();
    expect(elapsed).toBeLessThan(500);
  });

  it('load: 200 sequential forward slices over a 1k-commit log under 3s', () => {
    const { log, readsMap } = chainLog(1000);
    const reads = keysReadFromMap(readsMap);
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) {
      forwardSliceForKey(log, `k${k}`, reads, { maxDepth: 10, maxNodes: 50 });
    }
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('load: a value read by 2000 stages lists every read without blowing the node budget', () => {
    const log: CommitBundle[] = [commit('seed', 'seed#0', [{ key: 'hot' }], 0)];
    const readsMap: Record<string, string[]> = {};
    for (let i = 1; i <= 2000; i++) {
      const id = `r${i}#${i}`;
      log.push(commit(`r${i}`, id, [], i)); // reads only, writes nothing
      readsMap[id] = ['hot'];
    }
    const fwd = forwardSliceForKey(log, 'hot', keysReadFromMap(readsMap));
    expect(fwd.root!.reads).toHaveLength(2000);
    expect(fwd.root!.fedEdges).toEqual([]);
    expect(fwd.root!.truncated).toBeUndefined();
  });
});
