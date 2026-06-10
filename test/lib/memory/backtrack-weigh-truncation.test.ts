/**
 * RFC-003 D4 — `weigh` hook (consumer-injected edge weights) + truncation
 * visibility on the causal slice.
 *
 * - The ENGINE never computes weights: `EdgeWeigher` is called once per
 *   created edge; `undefined` → 1.0. Weights render in `formatCausalChain`
 *   as `← via systemPrompt (0.18)` — only when ≠ 1.0.
 * - `root.truncated` reports `{ byDepth, byNodes }` when a limit actually
 *   cut the slice; absent on complete slices. Dev mode warns.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../src/index.js';
import type { EdgeWeigher } from '../../../src/lib/memory/backtrack.js';
import { causalChain, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';

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

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('causalChain — weigh hook (D4)', () => {
  it('weigher receives (child, parent, key, kind) and stamps edge weights', () => {
    const log = [
      commit('write-prompt', 'write-prompt#0', ['systemPrompt'], 0),
      commit('call-llm', 'call-llm#1', ['answer'], 1),
    ];
    const reads = readsFrom({ 'call-llm#1': ['systemPrompt'] });

    const calls: Array<{ child: string; parent: string; key?: string; kind: string }> = [];
    const weigh: EdgeWeigher = (child, parent, key, kind) => {
      calls.push({ child: child.runtimeStageId, parent: parent.runtimeStageId, key, kind });
      return 0.18;
    };

    const root = causalChain(log, 'call-llm#1', reads, { weigh })!;
    expect(root.parentEdges[0].weight).toBe(0.18);
    expect(calls).toEqual([{ child: 'call-llm#1', parent: 'write-prompt#0', key: 'systemPrompt', kind: 'data' }]);
  });

  it('weigher returning undefined → weight defaults to 1.0', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const reads = readsFrom({ 'b#1': ['x'] });
    const root = causalChain(log, 'b#1', reads, { weigh: () => undefined })!;
    expect(root.parentEdges[0].weight).toBe(1.0);
  });

  it('no weigher → weights are 1.0 and the weigher is never required', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const root = causalChain(log, 'b#1', readsFrom({ 'b#1': ['x'] }))!;
    expect(root.parentEdges[0].weight).toBe(1.0);
  });

  it('weigher applies to CONTROL edges too, with the label as key', () => {
    const log = [commit('decide', 'decide#0', [], 0), commit('branch', 'branch#1', ['out'], 1)];
    const seen: Array<{ key?: string; kind: string }> = [];
    const root = causalChain(log, 'branch#1', readsFrom({}), {
      controlDeps: (id) => (id === 'branch#1' ? { deciderId: 'decide#0', label: 'Good credit' } : undefined),
      weigh: (_c, _p, key, kind) => {
        seen.push({ key, kind });
        return 0.5;
      },
    })!;
    expect(seen).toEqual([{ key: 'Good credit', kind: 'control' }]);
    expect(root.parentEdges[0].weight).toBe(0.5);
  });

  it('formatCausalChain renders ← via key (weight) — and stays unchanged at weight 1.0', () => {
    const log = [
      commit('write-prompt', 'write-prompt#0', ['systemPrompt'], 0),
      commit('call-llm', 'call-llm#1', ['answer'], 1),
    ];
    const reads = readsFrom({ 'call-llm#1': ['systemPrompt'] });

    const weighted = formatCausalChain(causalChain(log, 'call-llm#1', reads, { weigh: () => 0.18 })!);
    expect(weighted).toContain('← via systemPrompt (0.18)');

    const unweighted = formatCausalChain(causalChain(log, 'call-llm#1', reads)!);
    expect(unweighted).toContain('← via systemPrompt [wrote: systemPrompt]');
    expect(unweighted).not.toContain('(0.18)');
    expect(unweighted).not.toContain('(1)');
  });

  it('formatCausalChain renders control-edge weights: [control: label] (w)', () => {
    const log = [commit('decide', 'decide#0', [], 0), commit('branch', 'branch#1', ['out'], 1)];
    const text = formatCausalChain(
      causalChain(log, 'branch#1', readsFrom({}), {
        controlDeps: (id) => (id === 'branch#1' ? { deciderId: 'decide#0', label: 'rule' } : undefined),
        weigh: () => 0.4,
      })!,
    );
    expect(text).toContain('← [control: rule] (0.4)');
  });
});

describe('causalChain — truncation visibility (D4)', () => {
  /** Linear chain of n stages, each reading what the previous wrote. */
  function chainLog(n: number): { log: CommitBundle[]; reads: (id: string) => string[] } {
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) {
      log.push(commit(`s${i}`, `s${i}#${i}`, [`k${i}`], i));
      if (i > 0) readsMap[`s${i}#${i}`] = [`k${i - 1}`];
    }
    return { log, reads: readsFrom(readsMap) };
  }

  it('complete slice → truncated is ABSENT (not false-valued)', () => {
    const { log, reads } = chainLog(5);
    const root = causalChain(log, 's4#4', reads)!;
    expect(root.truncated).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(root, 'truncated')).toBe(false);
  });

  it('depth limit cutting a still-expandable node → truncated.byDepth', () => {
    const { log, reads } = chainLog(10);
    const root = causalChain(log, 's9#9', reads, { maxDepth: 3 })!;
    expect(root.truncated).toEqual({ byDepth: true, byNodes: false });
  });

  it('depth horizon landing on a LEAF (nothing to expand) → no truncation', () => {
    const { log, reads } = chainLog(4);
    // s0 (the leaf, no reads) sits exactly at depth 3
    const root = causalChain(log, 's3#3', reads, { maxDepth: 3 })!;
    expect(root.truncated).toBeUndefined();
  });

  it('node budget dropping a discovered parent → truncated.byNodes', () => {
    const { log, reads } = chainLog(10);
    const root = causalChain(log, 's9#9', reads, { maxNodes: 3 })!;
    expect(root.truncated?.byNodes).toBe(true);
  });

  it('formatCausalChain appends the truncation footer', () => {
    const { log, reads } = chainLog(10);
    const truncated = formatCausalChain(causalChain(log, 's9#9', reads, { maxDepth: 3 })!);
    expect(truncated).toContain('⚠ slice truncated (maxDepth reached) — older causes exist beyond this horizon');

    const complete = formatCausalChain(causalChain(log, 's9#9', reads)!);
    expect(complete).not.toContain('slice truncated');
  });

  it('dev mode warns on truncation; production stays silent', () => {
    const { log, reads } = chainLog(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    causalChain(log, 's9#9', reads, { maxDepth: 3 });
    expect(warn).not.toHaveBeenCalled();

    enableDevMode();
    causalChain(log, 's9#9', reads, { maxDepth: 3 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('truncated by maxDepth (3)');

    warn.mockClear();
    causalChain(log, 's9#9', reads); // complete slice — no warning even in dev
    expect(warn).not.toHaveBeenCalled();
  });

  it('both limits cut → both flags, both causes in the footer', () => {
    // Fan-out: root reads 10 keys from distinct writers (more than the
    // node budget allows → byNodes) and the FIRST-created writer still has
    // reads of its own at the depth horizon (→ byDepth).
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    log.push(commit('deep', 'deep#0', ['dk'], 0));
    for (let i = 0; i < 10; i++) log.push(commit(`w${i}`, `w${i}#${i + 1}`, [`k${i}`], i + 1));
    log.push(commit('root', 'root#11', ['out'], 11));
    readsMap['root#11'] = Array.from({ length: 10 }, (_, i) => `k${i}`);
    readsMap['w0#1'] = ['dk']; // expandable, but sits AT the depth horizon

    const root = causalChain(log, 'root#11', readsFrom(readsMap), { maxDepth: 1, maxNodes: 5 })!;
    expect(root.truncated).toEqual({ byDepth: true, byNodes: true });

    const text = formatCausalChain(root);
    expect(text).toContain('⚠ slice truncated (maxDepth reached, maxNodes reached)');
  });
});
