/**
 * Comprehensive tests for causalChain() — backward program slicing on commit log.
 *
 * Test categories:
 * 1. Topology: linear chain, fan-in, fan-out, diamond, deep chain, single node
 * 2. Edge cases: empty commitLog, unknown startId, stage with no reads, no writers found
 * 3. DAG correctness: shared parents are deduped, cycles prevented by visited set
 * 4. Limits: maxDepth, maxNodes
 * 5. Utilities: flattenCausalDAG, formatCausalChain
 * 6. Loop scenarios: same stageId executed multiple times (agent loop pattern)
 * 7. Subflow scenarios: keys written inside subflows
 */

import { describe, expect, it } from 'vitest';

import {
  type CausalNode,
  _REVERSE_INDEX_THRESHOLD,
  causalChain,
  flattenCausalDAG,
  formatCausalChain,
} from '../../../src/lib/memory/backtrack.js';
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

/** Build a keysRead lookup from a plain object. */
function readsFrom(map: Record<string, string[]>): (id: string) => string[] {
  return (id: string) => map[id] ?? [];
}

// Helper: collect runtimeStageIds from DAG in BFS order
function bfsIds(root: CausalNode): string[] {
  return flattenCausalDAG(root).map((n) => n.runtimeStageId);
}

// ════════════════════════════════════════════════════════════════════════
// 1. TOPOLOGY TESTS
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — topology', () => {
  it('linear chain: A → B → C (each reads what previous wrote)', () => {
    // A writes x, B reads x writes y, C reads y writes z
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1), commit('C', 'c#2', ['z'], 2)];
    const reads = readsFrom({
      'a#0': [],
      'b#1': ['x'],
      'c#2': ['y'],
    });

    const root = causalChain(log, 'c#2', reads)!;
    expect(root.runtimeStageId).toBe('c#2');
    expect(root.depth).toBe(0);
    expect(root.parents).toHaveLength(1);

    const b = root.parents[0];
    expect(b.runtimeStageId).toBe('b#1');
    expect(b.linkedBy).toBe('y');
    expect(b.depth).toBe(1);
    expect(b.parents).toHaveLength(1);

    const a = b.parents[0];
    expect(a.runtimeStageId).toBe('a#0');
    expect(a.linkedBy).toBe('x');
    expect(a.depth).toBe(2);
    expect(a.parents).toHaveLength(0); // no reads → no parents
  });

  it('fan-in: C reads from both A and B', () => {
    // A writes x, B writes y, C reads x AND y
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1), commit('C', 'c#2', ['z'], 2)];
    const reads = readsFrom({
      'c#2': ['x', 'y'],
      'a#0': [],
      'b#1': [],
    });

    const root = causalChain(log, 'c#2', reads)!;
    expect(root.parents).toHaveLength(2);

    const parentIds = root.parents.map((p) => p.runtimeStageId).sort();
    expect(parentIds).toEqual(['a#0', 'b#1']);

    // Check linkedBy
    const aParent = root.parents.find((p) => p.runtimeStageId === 'a#0')!;
    const bParent = root.parents.find((p) => p.runtimeStageId === 'b#1')!;
    expect(aParent.linkedBy).toBe('x');
    expect(bParent.linkedBy).toBe('y');
  });

  it('fan-out: A is parent of both B and C', () => {
    // A writes x, B reads x, C reads x. Backtrack from C, should find A.
    // Then backtrack from B, should also find A.
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1), commit('C', 'c#2', ['z'], 2)];
    const reads = readsFrom({
      'b#1': ['x'],
      'c#2': ['x'],
      'a#0': [],
    });

    const rootC = causalChain(log, 'c#2', reads)!;
    expect(rootC.parents).toHaveLength(1);
    expect(rootC.parents[0].runtimeStageId).toBe('a#0');

    const rootB = causalChain(log, 'b#1', reads)!;
    expect(rootB.parents).toHaveLength(1);
    expect(rootB.parents[0].runtimeStageId).toBe('a#0');
  });

  it('diamond: D reads from B and C, both read from A', () => {
    // A → B → D
    // A → C → D
    const log = [
      commit('A', 'a#0', ['x'], 0),
      commit('B', 'b#1', ['y'], 1),
      commit('C', 'c#2', ['z'], 2),
      commit('D', 'd#3', ['result'], 3),
    ];
    const reads = readsFrom({
      'd#3': ['y', 'z'],
      'b#1': ['x'],
      'c#2': ['x'],
      'a#0': [],
    });

    const root = causalChain(log, 'd#3', reads)!;
    expect(root.parents).toHaveLength(2);

    const b = root.parents.find((p) => p.runtimeStageId === 'b#1')!;
    const c = root.parents.find((p) => p.runtimeStageId === 'c#2')!;

    // Both B and C have A as parent
    expect(b.parents).toHaveLength(1);
    expect(b.parents[0].runtimeStageId).toBe('a#0');

    expect(c.parents).toHaveLength(1);
    expect(c.parents[0].runtimeStageId).toBe('a#0');

    // DAG dedup: B.parents[0] and C.parents[0] should be the SAME node
    expect(b.parents[0]).toBe(c.parents[0]);
  });

  it('deep chain: 5 stages in sequence', () => {
    const log = [
      commit('S0', 's0#0', ['k0'], 0),
      commit('S1', 's1#1', ['k1'], 1),
      commit('S2', 's2#2', ['k2'], 2),
      commit('S3', 's3#3', ['k3'], 3),
      commit('S4', 's4#4', ['k4'], 4),
    ];
    const reads = readsFrom({
      's4#4': ['k3'],
      's3#3': ['k2'],
      's2#2': ['k1'],
      's1#1': ['k0'],
      's0#0': [],
    });

    const root = causalChain(log, 's4#4', reads)!;
    const flat = flattenCausalDAG(root);
    expect(flat).toHaveLength(5);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('single node: no parents', () => {
    const log = [commit('Seed', 'seed#0', ['data'], 0)];
    const reads = readsFrom({ 'seed#0': [] });

    const root = causalChain(log, 'seed#0', reads)!;
    expect(root.parents).toHaveLength(0);
    expect(root.depth).toBe(0);
    expect(flattenCausalDAG(root)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. EDGE CASES
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — edge cases', () => {
  it('empty commitLog → undefined', () => {
    const result = causalChain([], 'x#0', () => []);
    expect(result).toBeUndefined();
  });

  it('unknown startId → undefined', () => {
    const log = [commit('A', 'a#0', ['x'], 0)];
    const result = causalChain(log, 'unknown#99', () => []);
    expect(result).toBeUndefined();
  });

  it('start stage has no reads → root only, no parents', () => {
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1)];
    const reads = readsFrom({ 'b#1': [], 'a#0': [] });

    const root = causalChain(log, 'b#1', reads)!;
    expect(root.parents).toHaveLength(0);
  });

  it('reads a key that nobody wrote → no parent for that key', () => {
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1)];
    // B reads 'nonexistent' — no writer → no parent
    const reads = readsFrom({ 'b#1': ['nonexistent'] });

    const root = causalChain(log, 'b#1', reads)!;
    expect(root.parents).toHaveLength(0);
  });

  it('reads key written by self (same stage) → skipped (findLastWriter searches before idx)', () => {
    // Stage A writes x, then reads x from itself — should NOT create self-loop
    const log = [commit('A', 'a#0', ['x'], 0)];
    const reads = readsFrom({ 'a#0': ['x'] });

    const root = causalChain(log, 'a#0', reads)!;
    // findLastWriter(commitLog, 'x', 0) searches before index 0 → nothing found
    expect(root.parents).toHaveLength(0);
  });

  it('multiple keys read from the same writer → single parent (deduped)', () => {
    // A writes x AND y. B reads both x and y.
    const log = [commit('A', 'a#0', ['x', 'y'], 0), commit('B', 'b#1', ['z'], 1)];
    const reads = readsFrom({ 'b#1': ['x', 'y'], 'a#0': [] });

    const root = causalChain(log, 'b#1', reads)!;
    // Only one parent (A), even though two keys led there
    expect(root.parents).toHaveLength(1);
    expect(root.parents[0].runtimeStageId).toBe('a#0');
  });

  it('key overwritten multiple times → finds last writer only', () => {
    // A writes x, B overwrites x, C reads x → parent is B not A
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['x'], 1), commit('C', 'c#2', ['z'], 2)];
    const reads = readsFrom({ 'c#2': ['x'], 'b#1': [], 'a#0': [] });

    const root = causalChain(log, 'c#2', reads)!;
    expect(root.parents).toHaveLength(1);
    expect(root.parents[0].runtimeStageId).toBe('b#1');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. LIMITS
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — limits', () => {
  it('maxDepth stops traversal', () => {
    const log = [
      commit('A', 'a#0', ['k0'], 0),
      commit('B', 'b#1', ['k1'], 1),
      commit('C', 'c#2', ['k2'], 2),
      commit('D', 'd#3', ['k3'], 3),
    ];
    const reads = readsFrom({
      'd#3': ['k2'],
      'c#2': ['k1'],
      'b#1': ['k0'],
      'a#0': [],
    });

    const root = causalChain(log, 'd#3', reads, { maxDepth: 1 })!;
    const flat = flattenCausalDAG(root);
    // depth 0: D, depth 1: C — stops here (maxDepth=1 means don't go beyond depth 1)
    expect(flat.length).toBeLessThanOrEqual(2);
  });

  it('maxNodes caps total visited', () => {
    // Fan-in: D reads from A, B, C. maxNodes=2 → only D + 1 parent
    const log = [
      commit('A', 'a#0', ['x'], 0),
      commit('B', 'b#1', ['y'], 1),
      commit('C', 'c#2', ['z'], 2),
      commit('D', 'd#3', ['result'], 3),
    ];
    const reads = readsFrom({
      'd#3': ['x', 'y', 'z'],
      'a#0': [],
      'b#1': [],
      'c#2': [],
    });

    const root = causalChain(log, 'd#3', reads, { maxNodes: 2 })!;
    const flat = flattenCausalDAG(root);
    expect(flat.length).toBeLessThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. LOOP SCENARIOS (same stageId, different runtimeStageId)
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — loop scenarios', () => {
  it('agent loop: same stage executes 3 times, last reads from previous iteration', () => {
    // call-llm runs 3 times. Each reads 'messages' written by previous.
    const log = [
      commit('seed', 'seed#0', ['systemPrompt', 'messages'], 0),
      commit('call-llm', 'call-llm#1', ['response', 'messages'], 1),
      commit('call-llm', 'call-llm#2', ['response', 'messages'], 2),
      commit('call-llm', 'call-llm#3', ['response', 'messages'], 3),
    ];
    const reads = readsFrom({
      'call-llm#3': ['messages', 'systemPrompt'],
      'call-llm#2': ['messages', 'systemPrompt'],
      'call-llm#1': ['messages', 'systemPrompt'],
      'seed#0': [],
    });

    const root = causalChain(log, 'call-llm#3', reads)!;
    expect(root.runtimeStageId).toBe('call-llm#3');

    // Should trace back: #3 ← #2 (messages) ← #1 (messages) ← seed (messages, systemPrompt)
    // Also #3 reads systemPrompt from seed directly
    const flat = flattenCausalDAG(root);
    expect(flat.map((n) => n.runtimeStageId)).toContain('call-llm#2');
    expect(flat.map((n) => n.runtimeStageId)).toContain('seed#0');
  });

  it('loop does not create cycles even if same stageId appears', () => {
    // Ensure visited set prevents infinite loops
    const log = [
      commit('step', 'step#0', ['counter'], 0),
      commit('step', 'step#1', ['counter'], 1),
      commit('step', 'step#2', ['counter'], 2),
    ];
    const reads = readsFrom({
      'step#2': ['counter'],
      'step#1': ['counter'],
      'step#0': ['counter'], // reads counter but step#0 is at idx 0 so findLastWriter finds nothing
    });

    const root = causalChain(log, 'step#2', reads)!;
    const flat = flattenCausalDAG(root);
    // Should terminate without infinite loop
    expect(flat.length).toBeLessThanOrEqual(3);
    expect(flat.map((n) => n.runtimeStageId)).toEqual(['step#2', 'step#1', 'step#0']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. SUBFLOW SCENARIOS
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — subflow scenarios', () => {
  it('subflow stage writes data consumed by parent stage after subflow', () => {
    const log = [
      commit('seed', 'seed#0', ['orderId', 'amount'], 0),
      commit('sf-pay/validate', 'sf-pay/validate#1', ['cardValid'], 1),
      commit('sf-pay/charge', 'sf-pay/charge#2', ['txnId'], 2),
      commit('ship', 'ship#3', ['shipped'], 3),
    ];
    const reads = readsFrom({
      'ship#3': ['txnId', 'orderId'],
      'sf-pay/charge#2': ['cardValid', 'amount'],
      'sf-pay/validate#1': ['amount'],
      'seed#0': [],
    });

    const root = causalChain(log, 'ship#3', reads)!;
    const flat = flattenCausalDAG(root);
    const ids = flat.map((n) => n.runtimeStageId);

    expect(ids).toContain('sf-pay/charge#2'); // wrote txnId
    expect(ids).toContain('seed#0'); // wrote orderId
    // Full chain should go: ship ← sf-pay/charge ← sf-pay/validate ← seed
    expect(flat.length).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. UTILITIES
// ════════════════════════════════════════════════════════════════════════

describe('flattenCausalDAG', () => {
  it('BFS order, each node exactly once', () => {
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1), commit('C', 'c#2', ['z'], 2)];
    const reads = readsFrom({ 'c#2': ['y'], 'b#1': ['x'], 'a#0': [] });

    const root = causalChain(log, 'c#2', reads)!;
    const flat = flattenCausalDAG(root);
    expect(flat.map((n) => n.runtimeStageId)).toEqual(['c#2', 'b#1', 'a#0']);
  });

  it('diamond deduplication', () => {
    const log = [
      commit('A', 'a#0', ['x'], 0),
      commit('B', 'b#1', ['y'], 1),
      commit('C', 'c#2', ['z'], 2),
      commit('D', 'd#3', ['result'], 3),
    ];
    const reads = readsFrom({
      'd#3': ['y', 'z'],
      'b#1': ['x'],
      'c#2': ['x'],
      'a#0': [],
    });

    const root = causalChain(log, 'd#3', reads)!;
    const flat = flattenCausalDAG(root);
    // A appears once despite being reachable from both B and C
    const ids = flat.map((n) => n.runtimeStageId);
    expect(ids.filter((id) => id === 'a#0')).toHaveLength(1);
    expect(flat).toHaveLength(4);
  });
});

describe('formatCausalChain', () => {
  it('produces human-readable output', () => {
    const log = [commit('Seed', 'seed#0', ['creditScore'], 0), commit('CallLLM', 'llm#1', ['response'], 1)];
    const reads = readsFrom({ 'llm#1': ['creditScore'], 'seed#0': [] });

    const root = causalChain(log, 'llm#1', reads)!;
    const text = formatCausalChain(root);

    expect(text).toContain('CallLLM (llm#1)');
    expect(text).toContain('Seed (seed#0)');
    expect(text).toContain('via creditScore');
    expect(text).toContain('wrote:');
  });

  it('marks shared parents as (see above)', () => {
    const log = [
      commit('A', 'a#0', ['x'], 0),
      commit('B', 'b#1', ['y'], 1),
      commit('C', 'c#2', ['z'], 2),
      commit('D', 'd#3', ['r'], 3),
    ];
    const reads = readsFrom({
      'd#3': ['y', 'z'],
      'b#1': ['x'],
      'c#2': ['x'],
      'a#0': [],
    });

    const root = causalChain(log, 'd#3', reads)!;
    const text = formatCausalChain(root);
    expect(text).toContain('see above');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. STAGED OPTIMIZATION — reverse index for large commit logs
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — staged optimization', () => {
  it('threshold constant is exposed for testing', () => {
    expect(_REVERSE_INDEX_THRESHOLD).toBe(256);
  });

  it('produces correct results with reverse index (large log above threshold)', () => {
    // Build a commit log larger than the threshold
    const N = _REVERSE_INDEX_THRESHOLD + 50;
    const log: CommitBundle[] = [];

    // First stage writes 'seed'
    log.push(commit('seed', 'seed#0', ['seed'], 0));

    // N intermediate stages: each reads 'seed', writes 'k{i}'
    for (let i = 1; i < N - 1; i++) {
      log.push(commit(`s${i}`, `s${i}#${i}`, [`k${i}`], i));
    }

    // Last stage reads from several intermediate stages
    log.push(commit('final', `final#${N - 1}`, ['result'], N - 1));

    const reads = readsFrom({
      [`final#${N - 1}`]: ['k1', 'k100', 'seed'],
      's1#1': ['seed'],
      's100#100': ['seed'],
      'seed#0': [],
    });

    const root = causalChain(log, `final#${N - 1}`, reads)!;
    expect(root.runtimeStageId).toBe(`final#${N - 1}`);

    const flat = flattenCausalDAG(root);
    const ids = flat.map((n) => n.runtimeStageId);

    // Should find s1, s100, and seed as parents
    expect(ids).toContain('s1#1');
    expect(ids).toContain('s100#100');
    expect(ids).toContain('seed#0');
  });

  it('reverse index handles key overwritten many times — finds last writer', () => {
    const N = _REVERSE_INDEX_THRESHOLD + 10;
    const log: CommitBundle[] = [];

    // 300 stages all writing 'counter'
    for (let i = 0; i < N; i++) {
      log.push(commit('step', `step#${i}`, ['counter'], i));
    }

    // Reader at the end reads 'counter' — should find step#(N-2), the one before it
    const reads = readsFrom({
      [`step#${N - 1}`]: ['counter'],
      [`step#${N - 2}`]: [],
    });

    const root = causalChain(log, `step#${N - 1}`, reads)!;
    expect(root.parents).toHaveLength(1);
    expect(root.parents[0].runtimeStageId).toBe(`step#${N - 2}`);
  });

  it('reverse index returns undefined for key nobody wrote', () => {
    const N = _REVERSE_INDEX_THRESHOLD + 10;
    const log: CommitBundle[] = [];
    for (let i = 0; i < N; i++) {
      log.push(commit(`s${i}`, `s${i}#${i}`, [`k${i}`], i));
    }

    const reads = readsFrom({ [`s${N - 1}#${N - 1}`]: ['nonexistent'] });
    const root = causalChain(log, `s${N - 1}#${N - 1}`, reads)!;
    expect(root.parents).toHaveLength(0);
  });

  it('linear scan and reverse index produce identical DAGs', () => {
    // Build the same scenario at two sizes and compare structure
    function buildScenario(size: number) {
      const log: CommitBundle[] = [commit('seed', 'seed#0', ['x', 'y'], 0)];
      for (let i = 1; i < size - 2; i++) {
        log.push(commit(`pad${i}`, `pad${i}#${i}`, [`p${i}`], i));
      }
      log.push(commit('mid', `mid#${size - 2}`, ['z'], size - 2));
      log.push(commit('end', `end#${size - 1}`, ['result'], size - 1));

      const reads = readsFrom({
        [`end#${size - 1}`]: ['x', 'z'],
        [`mid#${size - 2}`]: ['y'],
        'seed#0': [],
      });
      return { log, reads, startId: `end#${size - 1}` };
    }

    // Small (linear scan)
    const small = buildScenario(10);
    const smallRoot = causalChain(small.log, small.startId, small.reads)!;
    const smallFlat = flattenCausalDAG(smallRoot);

    // Large (reverse index)
    const large = buildScenario(_REVERSE_INDEX_THRESHOLD + 50);
    const largeRoot = causalChain(large.log, large.startId, large.reads)!;
    const largeFlat = flattenCausalDAG(largeRoot);

    // Same structure: end → seed (via x) + mid (via z) → seed (via y)
    expect(smallFlat.map((n) => n.stageName)).toEqual(largeFlat.map((n) => n.stageName));
    expect(smallFlat.map((n) => n.linkedBy)).toEqual(largeFlat.map((n) => n.linkedBy));
    expect(smallFlat.map((n) => n.depth)).toEqual(largeFlat.map((n) => n.depth));
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8. ADDITIONAL COVERAGE — edge cases for 100% coverage
// ════════════════════════════════════════════════════════════════════════

describe('causalChain — additional coverage', () => {
  it('duplicate keys in getKeysRead → same writer found once (deduped)', () => {
    const log = [commit('A', 'a#0', ['x'], 0), commit('B', 'b#1', ['y'], 1)];
    const reads = readsFrom({ 'b#1': ['x', 'x', 'x'] });

    const root = causalChain(log, 'b#1', reads)!;
    expect(root.parents).toHaveLength(1);
    expect(root.parents[0].runtimeStageId).toBe('a#0');
  });

  it('stage with empty keysWritten in trace', () => {
    const log = [
      commit('A', 'a#0', [], 0), // wrote nothing
      commit('B', 'b#1', ['y'], 1),
    ];
    const reads = readsFrom({ 'b#1': ['x'] });

    const root = causalChain(log, 'b#1', reads)!;
    // A wrote nothing, so it can't be found as writer of 'x'
    expect(root.parents).toHaveLength(0);
  });

  it('getKeysRead returns unknown keys gracefully', () => {
    const log = [commit('A', 'a#0', ['x'], 0)];
    const reads = readsFrom({ 'a#0': ['ghost1', 'ghost2', 'ghost3'] });

    const root = causalChain(log, 'a#0', reads)!;
    expect(root.parents).toHaveLength(0); // no writers found before idx 0
  });

  it('formatCausalChain with no parents', () => {
    const log = [commit('Only', 'only#0', ['data'], 0)];
    const reads = readsFrom({ 'only#0': [] });

    const root = causalChain(log, 'only#0', reads)!;
    const text = formatCausalChain(root);
    expect(text).toContain('Only (only#0)');
    expect(text).toContain('wrote: data');
    expect(text.split('\n')).toHaveLength(1); // just one line
  });

  it('flattenCausalDAG on single node', () => {
    const node: CausalNode = {
      runtimeStageId: 'x#0',
      stageId: 'x',
      stageName: 'X',
      keysWritten: [],
      linkedBy: '',
      depth: 0,
      parents: [],
    };
    expect(flattenCausalDAG(node)).toEqual([node]);
  });
});
