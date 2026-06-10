/**
 * RFC-003 D2 — untracked-read honesty flags (`CommitBundle.untrackedSources`).
 *
 * A causal slice is built from TRACKED reads (onRead events / keysRead).
 * Three read paths bypass tracking: `getArgs()` (untracked by design),
 * `getEnv()` (untracked by design), and silent reads
 * (`getValueSilent`/`getValueDirect`). D2 marks the stage's commit bundle
 * so slice consumers are TOLD when the slice may be incomplete.
 *
 * Sections:
 * - functional: each source flags; absent when unused (byte-shape pinned)
 * - shadowing: silent reads covered by a tracked read of the same key are
 *   NOT flagged (TypedScope array proxy + $batchArray stay quiet)
 * - lifecycle: double-commit paths record the field exactly once
 * - backtracker: CausalNode.incompleteSources stamped; formatCausalChain
 *   renders the ⚠ honesty marker
 */

import { describe, expect, it } from 'vitest';

import type { ScopeFacade } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { causalChain, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';

type Loose = Record<string, unknown>;

function bundleFor(commitLog: CommitBundle[], stageId: string): CommitBundle | undefined {
  return commitLog.find((b) => b.stageId === stageId);
}

describe('untrackedSources — functional (each source flags)', () => {
  it("getArgs() with real input → ['args'] on that stage's bundle only", async () => {
    const chart = flowChart<Loose>(
      'UsesArgs',
      async (scope) => {
        const args = scope.$getArgs<{ requestId: string }>();
        scope.$setValue('echo', args.requestId);
      },
      'uses-args',
    )
      .addFunction(
        'NoArgs',
        async (scope) => {
          scope.$setValue('other', 1);
        },
        'no-args',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { requestId: 'req-1' } });
    const log = executor.getSnapshot().commitLog as CommitBundle[];

    expect(bundleFor(log, 'uses-args')?.untrackedSources).toEqual(['args']);
    expect(bundleFor(log, 'no-args')?.untrackedSources).toBeUndefined();
  });

  it('getArgs() with NO run input → not flagged (empty read carries no information)', async () => {
    const chart = flowChart<Loose>(
      'UsesArgs',
      async (scope) => {
        scope.$getArgs();
        scope.$setValue('k', 1);
      },
      'uses-args',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'uses-args')?.untrackedSources).toBeUndefined();
  });

  it("getEnv() with a real environment → ['env']; without one → not flagged", async () => {
    const mk = () =>
      flowChart<Loose>(
        'UsesEnv',
        async (scope) => {
          scope.$getEnv();
          scope.$setValue('k', 1);
        },
        'uses-env',
      ).build();

    const withEnv = new FlowChartExecutor(mk());
    await withEnv.run({ env: { traceId: 't-1' } });
    expect(bundleFor(withEnv.getSnapshot().commitLog as CommitBundle[], 'uses-env')?.untrackedSources).toEqual(['env']);

    const withoutEnv = new FlowChartExecutor(mk());
    await withoutEnv.run();
    expect(
      bundleFor(withoutEnv.getSnapshot().commitLog as CommitBundle[], 'uses-env')?.untrackedSources,
    ).toBeUndefined();
  });

  it("unshadowed silent read → ['silent']", async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('hidden', 42);
      },
      'seed',
    )
      .addFunction(
        'SilentReader',
        async (scope) => {
          // Bypass tracking deliberately: no tracked read of 'hidden' first.
          const raw = scope.$toRaw() as ScopeFacade;
          const v = raw.getValueSilent('hidden');
          scope.$setValue('derived', (v as number) + 1);
        },
        'silent-reader',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'silent-reader')?.untrackedSources).toEqual(['silent']);
    expect(bundleFor(log, 'seed')?.untrackedSources).toBeUndefined();
  });

  it("whole-state silent read (no key) → always ['silent']", async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('a', 1);
      },
      'seed',
    )
      .addFunction(
        'WholeState',
        async (scope) => {
          const raw = scope.$toRaw() as ScopeFacade;
          raw.getValueSilent();
          scope.$setValue('b', 2);
        },
        'whole-state',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'whole-state')?.untrackedSources).toEqual(['silent']);
  });

  it('multiple sources accumulate on one stage (insertion order, deduped)', async () => {
    const chart = flowChart<Loose>(
      'Everything',
      async (scope) => {
        scope.$getArgs();
        scope.$getArgs(); // dedup — still one 'args'
        scope.$getEnv();
        (scope.$toRaw() as ScopeFacade).getValueSilent('missing');
        scope.$setValue('k', 1);
      },
      'everything',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { x: 1 }, env: { traceId: 't' } });
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'everything')?.untrackedSources).toEqual(['args', 'env', 'silent']);
  });

  it('field is ABSENT (not empty-array-valued) on untouched stages — byte shape pinned', async () => {
    const chart = flowChart<Loose>(
      'Plain',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'plain',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const bundle = bundleFor(executor.getSnapshot().commitLog as CommitBundle[], 'plain')!;
    expect(Object.prototype.hasOwnProperty.call(bundle, 'untrackedSources')).toBe(false);
  });
});

describe('untrackedSources — shadowing (tracked read of the same key silences the flag)', () => {
  it('TypedScope array-proxy ops (tracked property read + silent internals) are NOT flagged', async () => {
    interface State {
      tags: string[];
      [key: string]: unknown;
    }
    const chart = flowChart<State>(
      'Seed',
      async (scope) => {
        scope.$setValue('tags', ['a']);
      },
      'seed',
    )
      .addFunction(
        'Pusher',
        async (scope) => {
          // Property access fires ONE tracked read; the array proxy's
          // internal getCurrent() reads are silent but SHADOWED.
          scope.tags.push('b');
        },
        'pusher',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'pusher')?.untrackedSources).toBeUndefined();
  });

  it('$batchArray is NOT flagged (its read is tracked)', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('items', [1]);
      },
      'seed',
    )
      .addFunction(
        'Batcher',
        async (scope) => {
          scope.$batchArray('items', (arr) => {
            arr.push(2, 3);
          });
        },
        'batcher',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'batcher')?.untrackedSources).toBeUndefined();
  });

  it('explicit silent read AFTER a tracked read of the same key is shadowed', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 7);
      },
      'seed',
    )
      .addFunction(
        'ReadBoth',
        async (scope) => {
          scope.$getValue('k'); // tracked
          (scope.$toRaw() as ScopeFacade).getValueSilent('k'); // shadowed
          scope.$setValue('out', 1);
        },
        'read-both',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'read-both')?.untrackedSources).toBeUndefined();
  });

  it('shadowing is per-KEY: silent read of a different key still flags', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 7);
        scope.$setValue('other', 8);
      },
      'seed',
    )
      .addFunction(
        'Mixed',
        async (scope) => {
          scope.$getValue('k'); // tracked read of k...
          (scope.$toRaw() as ScopeFacade).getValueSilent('other'); // ...does not shadow 'other'
          scope.$setValue('out', 1);
        },
        'mixed',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    expect(bundleFor(log, 'mixed')?.untrackedSources).toEqual(['silent']);
  });
});

describe('untrackedSources — lifecycle (double-commit records the field once)', () => {
  it('fork child using getArgs: only the FIRST commit bundle carries the field', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 'orig');
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'child-args',
          name: 'ChildArgs',
          fn: async (scope: { $getArgs(): unknown; $setValue(k: string, v: unknown): void }) => {
            scope.$getArgs();
            scope.$setValue('a', 1);
          },
        },
        {
          id: 'child-plain',
          name: 'ChildPlain',
          fn: async (scope: { $setValue(k: string, v: unknown): void }) => {
            scope.$setValue('b', 2);
          },
        },
      ])
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { x: 1 } });
    const log = executor.getSnapshot().commitLog as CommitBundle[];

    // Fork children double-commit routinely (#13b): the wrapper's second
    // commit is the empty fast path and must NOT re-report the markers.
    const childBundles = log.filter((b) => b.stageId === 'child-args');
    const flagged = childBundles.filter((b) => b.untrackedSources !== undefined);
    expect(flagged.length).toBe(1);
    expect(flagged[0].untrackedSources).toEqual(['args']);

    const plainBundles = log.filter((b) => b.stageId === 'child-plain');
    expect(plainBundles.every((b) => b.untrackedSources === undefined)).toBe(true);
  });
});

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

  it('end-to-end: a real run with getArgs surfaces the ⚠ in the formatted slice', async () => {
    const reads = new Map<string, string[]>();
    const chart = flowChart<Loose>(
      'PullBureau',
      async (scope) => {
        const { ssn } = scope.$getArgs<{ ssn: string }>();
        scope.$setValue('creditScore', ssn.length * 100);
      },
      'pull-bureau',
    )
      .addFunction(
        'Score',
        async (scope) => {
          const score = scope.$getValue('creditScore') as number;
          scope.$setValue('risk', score > 500 ? 'low' : 'high');
        },
        'score',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder({
      id: 'reads',
      onRead: (e) => {
        if (!e.key) return;
        const arr = reads.get(e.runtimeStageId) ?? [];
        arr.push(e.key);
        reads.set(e.runtimeStageId, arr);
      },
    });
    await executor.run({ input: { ssn: '123-45-6789' } });

    const log = executor.getSnapshot().commitLog as CommitBundle[];
    const scoreCommit = log.find((b) => b.stageId === 'score')!;
    const dag = causalChain(log, scoreCommit.runtimeStageId, (id) => reads.get(id) ?? [])!;
    const text = formatCausalChain(dag);

    expect(text).toContain('PullBureau');
    expect(text).toContain('⚠ also consumed args — slice may be incomplete here');
  });
});
