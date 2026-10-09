/** Record-owned incomplete-source labels and their causal-chain formatting.
 * untracked-sources.test.ts retains the engine's flagging and lifecycle witnesses. */
import { describe, expect, it } from 'vitest';

import { causalChain, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle } from '../../../src/trace.js';

describe('untrackedSources — backtracker integration (D2 stamps + ⚠ marker)', () => {
  function commit(
    stageId: string,
    runtimeStageId: string,
    keysWritten: string[],
    idx: number,
    untrackedSources?: CommitBundle['untrackedSources'],
  ): CommitBundle {
    return {
      idx,
      stage: stageId,
      stageId,
      runtimeStageId,
      trace: keysWritten.map((k) => ({ path: k, verb: 'set' as const })),
      redactedPaths: [],
      overwrite: Object.fromEntries(keysWritten.map((k) => [k, `val-${k}`])),
      updates: {},
      ...(untrackedSources && { untrackedSources }),
    };
  }

  it('causalChain stamps CausalNode.incompleteSources from the commit bundle', () => {
    const log = [commit('pull', 'pull#0', ['creditScore'], 0, ['args']), commit('score', 'score#1', ['risk'], 1)];
    const reads = (id: string) => (id === 'score#1' ? ['creditScore'] : []);

    const root = causalChain(log, 'score#1', reads)!;
    expect(root.incompleteSources).toBeUndefined();
    expect(root.parents[0].incompleteSources).toEqual(['args']);
  });

  it('formatCausalChain renders the ⚠ honesty marker for incomplete nodes', () => {
    const log = [
      commit('pull', 'pull#0', ['creditScore'], 0, ['args', 'env']),
      commit('score', 'score#1', ['risk'], 1),
    ];
    const reads = (id: string) => (id === 'score#1' ? ['creditScore'] : []);

    const text = formatCausalChain(causalChain(log, 'score#1', reads)!);
    expect(text).toContain('⚠ also consumed args/env — slice may be incomplete here');
    // The marker line nests one level under the flagged node.
    const lines = text.split('\n');
    const flaggedIdx = lines.findIndex((l) => l.includes('pull#0'));
    expect(lines[flaggedIdx + 1].trimStart().startsWith('⚠')).toBe(true);
  });

  it('format output is byte-identical to the legacy shape when no markers exist', () => {
    const log = [commit('a', 'a#0', ['x'], 0), commit('b', 'b#1', ['y'], 1)];
    const reads = (id: string) => (id === 'b#1' ? ['x'] : []);
    const text = formatCausalChain(causalChain(log, 'b#1', reads)!);
    expect(text).toBe('b (b#1) [wrote: y]\n  a (a#0) ← via x [wrote: x]');
  });
});
