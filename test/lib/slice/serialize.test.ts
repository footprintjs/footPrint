/**
 * sliceToJSON / formatSlice (backward) and forwardSliceToJSON /
 * formatForwardSlice / formatTimeline (forward) — the ONLY safe
 * serializations of this module's shapes.
 *
 * What is being pinned:
 * 1. LINEARITY (the must-fix): a diamond-heavy DAG serializes each node
 *    exactly once — output size grows linearly while naive
 *    JSON.stringify(root) grows combinatorially with diamond depth. The
 *    forward DAG shares nodes the same way and gets the same guarantee.
 * 2. The honesty envelope: missing reasons, the "reads were not recorded"
 *    warning (readTracking-off signature), truncation pass-through, and
 *    forward-only: every honesty note rendered, exact vs conservative edges
 *    visibly DIFFERENT in the string.
 * 3. Coverage telemetry propagation: KeysReadSource.coverage →
 *    VariableSlice.readsCoverage → both serializations.
 * 4. Bounded output for LLM tools, on every shape (including a timeline of
 *    thousands of moments) — truncation stated, never silent.
 */

import { describe, expect, it } from 'vitest';

import type { CommitBundle, StageSnapshot, TraceEntry } from '../../../src/lib/memory/types.js';
import {
  formatForwardSlice,
  formatSlice,
  formatTimeline,
  forwardSliceForKey,
  forwardSliceToJSON,
  keysReadFromExecutionTree,
  keysReadFromMap,
  keyTimeline,
  sliceForKey,
  sliceToJSON,
} from '../../../src/lib/slice/index.js';

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

/**
 * A diamond ladder of depth D: each level's node reads BOTH keys of the level
 * below — the worst case for naive stringification (every path re-serializes
 * the shared subtree; path count doubles per level).
 */
function diamondLadder(depth: number) {
  const log: CommitBundle[] = [commit('base', 'base#0', ['k0a', 'k0b'], 0)];
  const reads: Record<string, string[]> = { 'base#0': [] };
  let idx = 1;
  for (let d = 1; d <= depth; d++) {
    for (const side of ['a', 'b']) {
      const id = `n${d}${side}#${idx}`;
      log.push(commit(`n${d}${side}`, id, [`k${d}${side}`], idx));
      reads[id] = [`k${d - 1}a`, `k${d - 1}b`];
      idx++;
    }
  }
  const topId = `top#${idx}`;
  log.push(commit('top', topId, ['result'], idx));
  reads[topId] = [`k${depth}a`, `k${depth}b`];
  return { log, reads };
}

// ════════════════════════════════════════════════════════════════════════
// UNIT + the must-fix linearity pin
// ════════════════════════════════════════════════════════════════════════

describe('sliceToJSON', () => {
  it('serializes each DAG node exactly once, edges as id references', () => {
    const { log, reads } = diamondLadder(3);
    const slice = sliceForKey(log, 'result', keysReadFromMap(reads), { maxDepth: 50, maxNodes: 500 });
    const json = sliceToJSON(slice);

    expect(json.writerId).toMatch(/^top#/);
    // 1 base + 2 per level × 3 levels + 1 top = 8 nodes, each exactly once.
    expect(Object.keys(json.nodes!)).toHaveLength(8);
    // Each non-base node contributes 2 data edges.
    expect(json.edges!.filter((e) => e.kind === 'data')).toHaveLength(14);
    expect(json.edges!.every((e) => json.nodes![e.from] && json.nodes![e.to])).toBe(true);
    // Round-trippable, plain JSON.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('LINEARITY: deep diamonds stay linear where naive stringify explodes combinatorially', () => {
    // Path count through a diamond ladder doubles per level (2^depth); node
    // count grows by 2 per level. depth 14 → 32768 root-to-base paths but
    // only 30 nodes. Naive JSON.stringify(root) would materialize every
    // path; sliceToJSON must stay ~linear.
    const { log, reads } = diamondLadder(14);
    const slice = sliceForKey(log, 'result', keysReadFromMap(reads), { maxDepth: 100, maxNodes: 1000 });
    const t0 = performance.now();
    const json = sliceToJSON(slice);
    const serialized = JSON.stringify(json);
    const elapsed = performance.now() - t0;
    expect(Object.keys(json.nodes!)).toHaveLength(2 + 14 * 2);
    expect(serialized.length).toBeLessThan(50_000); // linear-scale output
    expect(elapsed).toBeLessThan(200);
  });

  it('missing slices serialize their reason and nothing else graph-shaped', () => {
    const json = sliceToJSON(sliceForKey([], 'ghost', keysReadFromMap({})));
    expect(json.missing).toBe('empty-log');
    expect(json.nodes).toBeUndefined();
    expect(json.edges).toBeUndefined();
    expect(json.writerId).toBeUndefined();
  });

  it('truncation flags pass through from the root', () => {
    const { log, reads } = diamondLadder(10);
    const slice = sliceForKey(log, 'result', keysReadFromMap(reads), { maxNodes: 5 });
    const json = sliceToJSON(slice);
    expect(json.truncated?.byNodes).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatSlice — the bounded LLM-tool string + honesty envelope
// ════════════════════════════════════════════════════════════════════════

describe('formatSlice', () => {
  it('renders the chain for a present slice with the reads breadcrumb', () => {
    const { log, reads } = diamondLadder(1);
    const out = formatSlice(sliceForKey(log, 'result', keysReadFromMap(reads)));
    expect(out).toContain("SLICE for 'result'");
    expect(out).toContain('reads via: map');
    expect(out).toContain('top');
    expect(out).toContain('← via');
  });

  it('missing: never-written explains the blind spot instead of guessing', () => {
    const log = [commit('a', 'a#0', ['x'], 0)];
    const out = formatSlice(sliceForKey(log, 'ghost', keysReadFromMap({})));
    expect(out).toContain('never written');
    expect(out).toContain('initial state');
    expect(out).toContain('closure');
  });

  it('warns when reads were not recorded (readTracking-off signature) instead of implying independence', () => {
    // Multi-step tree whose snapshot has NO stageReads anywhere — the
    // exact shape readTracking:'off' produces.
    const tree: StageSnapshot = {
      id: 'a',
      runtimeStageId: 'a#0',
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
      next: { id: 'b', runtimeStageId: 'b#1', logs: {}, errors: {}, metrics: {}, evals: {} },
    };
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const slice = sliceForKey(log, 'y', keysReadFromExecutionTree(tree));
    expect(slice.readsCoverage).toEqual({ steps: 2, stepsWithReads: 0 });
    const out = formatSlice(slice);
    expect(out).toContain('⚠ reads were not recorded');
    expect(out).toContain('unknowable, NOT absent');
  });

  it('bounded: budget-capped slice output stays small even over a huge log', () => {
    const { log, reads } = diamondLadder(14);
    const out = formatSlice(sliceForKey(log, 'result', keysReadFromMap(reads), { maxNodes: 20 }));
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain('slice truncated'); // formatCausalChain's footer passes through
  });
});

// ════════════════════════════════════════════════════════════════════════
// forwardSliceToJSON — the forward twin, same linearity guarantee
// ════════════════════════════════════════════════════════════════════════

/**
 * A forward diamond: `seed` writes k0; two stages read it and each write
 * their own key; a joiner reads BOTH and writes one key — so the joiner's
 * life is reached through two paths and must serialize once.
 */
function forwardDiamond(levels: number) {
  const log: CommitBundle[] = [
    {
      idx: 0,
      stage: 'seed',
      stageId: 'seed',
      runtimeStageId: 'seed#0',
      trace: [{ path: 'k0', verb: 'set' } as TraceEntry],
      redactedPaths: [],
      overwrite: { k0: 'v' },
      updates: {},
    },
  ];
  const reads: Record<string, string[]> = { 'seed#0': [] };
  let idx = 1;
  for (let d = 1; d <= levels; d++) {
    for (const side of ['a', 'b']) {
      const id = `n${d}${side}#${idx}`;
      log.push(commit(`n${d}${side}`, id, [`k${d}${side}`], idx));
      reads[id] = d === 1 ? ['k0'] : [`k${d - 1}a`, `k${d - 1}b`];
      idx++;
    }
  }
  const joinId = `join#${idx}`;
  log.push(commit('join', joinId, ['result'], idx));
  reads[joinId] = [`k${levels}a`, `k${levels}b`];
  return { log, reads };
}

describe('forwardSliceToJSON', () => {
  it('serializes each forward node exactly once, edges as id references', () => {
    const { log, reads } = forwardDiamond(2);
    const slice = forwardSliceForKey(log, 'k0', keysReadFromMap(reads), { maxDepth: 50, maxNodes: 500 });
    const json = forwardSliceToJSON(slice);

    expect(json.rootId).toBe('n0');
    // 1 seed life + 2 per level × 2 levels + 1 join = 6 nodes, each once.
    expect(json.nodes).toHaveLength(6);
    expect(new Set(json.nodes!.map((n) => n.id)).size).toBe(6);
    const ids = new Set(json.nodes!.map((n) => n.id));
    expect(json.edges!.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    // Every node carries the real join keys — ids are opaque, never parsed.
    expect(json.nodes!.every((n) => n.key.length > 0 && typeof n.depth === 'number')).toBe(true);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('LINEARITY: deep forward diamonds stay linear where naive stringify explodes', () => {
    const { log, reads } = forwardDiamond(12);
    const slice = forwardSliceForKey(log, 'k0', keysReadFromMap(reads), { maxDepth: 100, maxNodes: 1000 });
    const t0 = performance.now();
    const json = forwardSliceToJSON(slice);
    const serialized = JSON.stringify(json);
    const elapsed = performance.now() - t0;
    expect(json.nodes).toHaveLength(1 + 12 * 2 + 1);
    expect(serialized.length).toBeLessThan(50_000);
    expect(elapsed).toBeLessThan(200);
  });

  it('a missing forward slice serializes its reason and its notes, nothing graph-shaped', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const json = forwardSliceToJSON(forwardSliceForKey(log, 'ghost', keysReadFromMap({ 'b#1': ['x'] })));
    expect(json.missing).toBe('never-written');
    expect(json.nodes).toBeUndefined();
    expect(json.edges).toBeUndefined();
    expect(json.rootId).toBeUndefined();
    expect(json.notes[0].code).toBe('unknown-key');
  });

  it('truncation flags pass through from the root', () => {
    const { log, reads } = forwardDiamond(8);
    const json = forwardSliceToJSON(forwardSliceForKey(log, 'k0', keysReadFromMap(reads), { maxNodes: 4 }));
    expect(json.truncated?.byNodes).toBe(true);
    expect(json.notes.some((n) => n.code === 'truncated')).toBe(true);
  });

  it('edge basis survives serialization — a consumer can still tell exact from conservative', () => {
    const log: CommitBundle[] = [
      {
        idx: 0,
        stage: 'seed',
        stageId: 'seed',
        runtimeStageId: 'seed#0',
        trace: [{ path: 'k', verb: 'set', readKeys: [] } as TraceEntry],
        redactedPaths: [],
        overwrite: { k: 1 },
        updates: {},
      },
      {
        idx: 1,
        stage: 'use',
        stageId: 'use',
        runtimeStageId: 'use#1',
        trace: [{ path: 'out', verb: 'set', readKeys: ['k'] } as TraceEntry],
        redactedPaths: [],
        overwrite: { out: 2 },
        updates: {},
      },
    ];
    const json = forwardSliceToJSON(forwardSliceForKey(log, 'k', keysReadFromMap({ 'use#1': ['k'] })));
    expect(json.edges).toEqual([{ from: 'n0', to: 'n1', basis: 'per-write' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatForwardSlice / formatTimeline — the bounded LLM strings
// ════════════════════════════════════════════════════════════════════════

describe('formatForwardSlice', () => {
  const log: CommitBundle[] = [commit('seed', 'seed#0', ['k'], 0), commit('use', 'use#1', ['out'], 1)];
  const reads = keysReadFromMap({ 'use#1': ['k'] });

  it('renders the life, its readers, and what it fed', () => {
    const out = formatForwardSlice(forwardSliceForKey(log, 'k', reads));
    expect(out).toContain("FORWARD SLICE for 'k'");
    expect(out).toContain('reads via: map');
    expect(out).toContain('read by use (use#1) @1');
    expect(out).toContain('→ fed');
    expect(out).toContain("'out' set by use");
  });

  it('a conservative edge READS conservative, an exact edge reads exact', () => {
    const conservative = formatForwardSlice(forwardSliceForKey(log, 'k', reads));
    expect(conservative).toContain('[conservative]');
    expect(conservative).not.toContain('[exact]');
    expect(conservative).toContain('⚠ some');

    const withProvenance = log.map((b, i) =>
      i === 1 ? { ...b, trace: [{ path: 'out', verb: 'set' as const, readKeys: ['k'] }] } : b,
    );
    const exact = formatForwardSlice(forwardSliceForKey(withProvenance, 'k', reads));
    expect(exact).toContain('[exact]');
    expect(exact).not.toContain('[conservative]');
  });

  it('an unknown key renders the refusal and the known-keys list', () => {
    const out = formatForwardSlice(forwardSliceForKey(log, 'kk', reads));
    expect(out).toContain('never written and never read');
    expect(out).toContain("⚠ unknown key 'kk'");
    expect(out).toContain('Known keys: k, out');
  });

  it('a pre-run origin says the value came from outside the log', () => {
    const out = formatForwardSlice(forwardSliceForKey(log, 'seeded', keysReadFromMap({ 'use#1': ['seeded'] })));
    expect(out).toContain('from BEFORE the run');
    expect(out).toContain('⚠');
    expect(out).toContain('initial state');
  });

  it('bounded: a huge fan-out of reads caps the list and SAYS it capped', () => {
    const big: CommitBundle[] = [commit('seed', 'seed#0', ['hot'], 0)];
    const readsMap: Record<string, string[]> = {};
    for (let i = 1; i <= 500; i++) {
      big.push(commit(`r${i}`, `r${i}#${i}`, [], i));
      readsMap[`r${i}#${i}`] = ['hot'];
    }
    const out = formatForwardSlice(forwardSliceForKey(big, 'hot', keysReadFromMap(readsMap)));
    expect(out).toContain('… and 495 more reads');
    expect(out.length).toBeLessThan(2_000);
  });

  it('bounded: a budget-capped forward slice stays small and states the cut', () => {
    const { log: deep, reads: deepReads } = forwardDiamond(12);
    const out = formatForwardSlice(forwardSliceForKey(deep, 'k0', keysReadFromMap(deepReads), { maxNodes: 20 }));
    expect(out.length).toBeLessThan(8_000);
    expect(out).toContain('⚠ walk truncated');
  });

  it('shared nodes render once (`(see above)`), like formatCausalChain', () => {
    const { log: dia, reads: diaReads } = forwardDiamond(2);
    const out = formatForwardSlice(forwardSliceForKey(dia, 'k0', keysReadFromMap(diaReads), { maxNodes: 100 }));
    expect(out).toContain('(see above)');
  });
});

describe('formatTimeline', () => {
  const log: CommitBundle[] = [
    commit('seed', 'seed#0', ['k'], 0),
    commit('use', 'use#1', ['out'], 1),
    commit('rewrite', 'rewrite#2', ['k'], 2),
  ];
  const reads = keysReadFromMap({ 'use#1': ['k'] });

  it('renders each moment with its commit index, stage and attributed value', () => {
    const out = formatTimeline(keyTimeline(log, 'k', reads));
    expect(out).toContain("TIMELINE for 'k'");
    expect(out).toContain('@0 write set — seed (seed#0)');
    expect(out).toContain('@1 read  — use (use#1) (value from commit 0)');
    expect(out).toContain('@2 write set — rewrite (rewrite#2)');
  });

  it('a pre-run read says the value came from before the run', () => {
    const out = formatTimeline(keyTimeline(log, 'seeded', keysReadFromMap({ 'use#1': ['seeded'] })));
    expect(out).toContain('value from BEFORE the run');
    expect(out).toContain('⚠');
  });

  it('bounded: thousands of moments cap the output and SAY they capped', () => {
    const big: CommitBundle[] = [commit('seed', 'seed#0', ['hot'], 0)];
    const readsMap: Record<string, string[]> = {};
    for (let i = 1; i <= 3000; i++) {
      big.push(commit(`r${i}`, `r${i}#${i}`, [], i));
      readsMap[`r${i}#${i}`] = ['hot'];
    }
    const out = formatTimeline(keyTimeline(big, 'hot', keysReadFromMap(readsMap)));
    expect(out).toContain('more moments (bounded output)');
    expect(out.length).toBeLessThan(10_000);
  });

  it('an unknown key renders the refusal with the known-keys list', () => {
    const out = formatTimeline(keyTimeline(log, 'kk', reads));
    expect(out).toContain('never written and never read');
    expect(out).toContain("⚠ unknown key 'kk'");
  });

  it('the timeline is plain JSON by construction — stringify is safe and lossless', () => {
    const timeline = keyTimeline(log, 'k', reads);
    expect(JSON.parse(JSON.stringify(timeline))).toEqual(timeline);
  });
});
