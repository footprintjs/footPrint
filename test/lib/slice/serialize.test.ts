/**
 * sliceToJSON / formatSlice — the ONLY safe serializations of a slice.
 *
 * What is being pinned:
 * 1. LINEARITY (the must-fix): a diamond-heavy DAG serializes each node
 *    exactly once — output size grows linearly while naive
 *    JSON.stringify(root) grows combinatorially with diamond depth.
 * 2. The honesty envelope: missing reasons, the "reads were not recorded"
 *    warning (readTracking-off signature), truncation pass-through.
 * 3. Coverage telemetry propagation: KeysReadSource.coverage →
 *    VariableSlice.readsCoverage → both serializations.
 */

import { describe, expect, it } from 'vitest';

import type { CommitBundle, StageSnapshot } from '../../../src/lib/memory/types.js';
import {
  formatSlice,
  keysReadFromExecutionTree,
  keysReadFromMap,
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
