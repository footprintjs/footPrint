/**
 * One stage, one record (F8, 9.39.0).
 *
 * WRITER — the engine names every continuation of a stage's execution on the
 * bundle it writes (`CommitBundle.phase`): a mount's exit is `'exit'`, a fork
 * fan-out's settle commit is `'repeat'`, the stage's own bundle carries none.
 *
 * READERS — `commitStops` / `buildCommitIndex` group by `runtimeStageId` and
 * read `phase`; nothing infers a continuation from the log's shape. A log
 * written before 9.39.0 (no `phase` anywhere) is read by ONE legacy function,
 * `inferLegacyPhases`, exactly as 9.38.0 read it.
 *
 * THROTTLING (R9) — `throttlingErrorChecker` fires `FlowRecorder.onThrottled`;
 * the `monitor.isThrottled` write that never landed is gone.
 *
 * Test types: unit (hand-built logs), scenario (real runs), boundary (legacy
 * logs), security (no shape inference left in src — a grep).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { CommitBundle, CommitPhase } from 'foottrace';
import { buildCommitIndex, commitStops, inferLegacyPhases, recordsPhases, timeTravel } from 'foottrace';
import { describe, expect, it } from 'vitest';

import type { FlowRecorder, FlowThrottledEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type L = Record<string, unknown>;

function bundle(rtid: string, writes: L, phase?: 'exit' | 'repeat'): CommitBundle {
  const stageId = rtid.split('#')[0];
  return {
    stage: stageId.toUpperCase(),
    stageId,
    runtimeStageId: rtid,
    trace: Object.keys(writes).map((path) => ({ path, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: { ...writes },
    updates: {},
    ...(phase && { phase }),
  };
}

const kinds = (log: CommitBundle[], tree?: never) =>
  commitStops(log, tree).map((s) => [s.kind, s.runtimeStageId, s.commitIdx, s.lastCommitIdx]);

// ── Writer ────────────────────────────────────────────────────────────────

describe('the writer names every continuation', () => {
  it('a fork child: its own bundle, then the fan-out repeat (phase: repeat)', async () => {
    const chart = flowChart<L>('Seed', async (s: any) => s.$setValue('k', 0), 'seed')
      .addListOfFunction([
        { id: 'c1', name: 'C1', fn: async (s: any) => s.$setValue('c1', 1) },
        { id: 'c2', name: 'C2', fn: async (s: any) => s.$setValue('c2', 2) },
      ])
      .addFunction('Join', async () => undefined, 'join')
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const log = ex.getSnapshot().commitLog;
    for (const child of ['c1', 'c2']) {
      const own = log.filter((b) => b.stageId === child);
      expect(own.map((b) => b.phase)).toEqual([undefined, 'repeat']);
      expect(Object.prototype.hasOwnProperty.call(own[0], 'phase')).toBe(false);
    }
    // Every stage has exactly ONE bundle without a phase — its own.
    expect(log.filter((b) => b.phase === undefined).map((b) => b.stageId)).toEqual(['seed', 'c1', 'c2', 'join']);
  });

  it('a mount: merge-back (own), then the exit (phase: exit); a mount with no merge-back has ONE bundle, its own — no phase, tags on it', async () => {
    const inner = flowChart<L>('In', async (s: any) => s.$setValue('r', 1), 'in').build();
    const chart = flowChart<L>('Outer', async (s: any) => s.$setValue('o', 1), 'outer')
      .addSubFlowChartNext('sf-a', inner, 'A', { outputMapper: (o: L) => ({ r: o.r }) })
      .addSubFlowChartNext('m', inner, 'M', { tags: ['T'] })
      .addLazySubFlowChartNext('lazy', () => inner, 'Lazy')
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const snap = ex.getSnapshot();
    const rows = (id: string) =>
      snap.commitLog.filter((b) => b.stageId === id).map((b) => [b.runtimeStageId, b.phase, b.tags]);
    expect(rows('sf-a').map((r) => r[1])).toEqual([undefined, 'exit']);
    // THE LAW: the first bundle per runtimeStageId is the stage's own — no phase — and carries its tags.
    expect(rows('m')).toEqual([[expect.stringMatching(/^m#/), undefined, ['T']]]);
    expect(rows('lazy').map((r) => r[1])).toEqual([undefined]);
    // The tree names every mount; the tree-less axis names the one with a recorded exit.
    expect(
      commitStops(snap.commitLog, snap.executionTree)
        .filter((x) => x.kind === 'mount')
        .map((x) => x.stageId),
    ).toEqual(['sf-a', 'm', 'lazy']);
    expect(
      commitStops(snap.commitLog)
        .filter((x) => x.kind === 'mount')
        .map((x) => x.stageId),
    ).toEqual(['sf-a']);
  });

  it('every parallelForEach branch is a mapper-less mount: its one bundle is its own (no phase)', async () => {
    const leaf = (n: unknown) => flowChart<L>('Leaf', async (s: any) => s.$setValue('n', n), 'leaf').build();
    const chart = flowChart<L>('Seed', async (s: any) => s.$setValue('items', [1, 2]), 'seed')
      .addParallelForEach('Each', 'each', { items: (s: any) => s.items, branch: leaf, into: 'out', maxBranches: 4 })
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const log = ex.getSnapshot().commitLog;
    const firsts = new Set<string>();
    for (const b of log) {
      // Every first bundle per runtimeStageId — branches included — carries no phase.
      if (!firsts.has(b.runtimeStageId)) expect(b.phase).toBeUndefined();
      firsts.add(b.runtimeStageId);
    }
    const branches = log.filter((b) => b.runtimeStageId.includes('~'));
    expect(branches.length).toBeGreaterThan(0);
    // Each branch: its own bundle (the mount's exit — its ONLY own bundle — so no phase), then the
    // fan-out's settle commit (repeat). Until this fix the first was stamped 'exit'.
    for (const id of new Set(branches.map((b) => b.runtimeStageId))) {
      const phases: (CommitPhase | undefined)[] = branches.filter((b) => b.runtimeStageId === id).map((b) => b.phase);
      expect(phases).toEqual([undefined, 'repeat']);
    }
  });

  it('a fork child that is a mount: merge-back, exit, repeat — one stop, a mount', async () => {
    const inner = flowChart<L>('In', async (s: any) => s.$setValue('r', 1), 'in').build();
    const chart = flowChart<L>('Seed', async () => undefined, 'seed')
      .addSubFlowChart('sf-c', inner, 'C', { outputMapper: (o: L) => ({ r: o.r }) })
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const snap = ex.getSnapshot();
    const group = snap.commitLog.filter((b) => b.stageId === 'sf-c');
    expect(group.map((b) => b.phase)).toEqual([undefined, 'exit', 'repeat']);
    expect(commitStops(snap.commitLog).map((s) => s.kind)).toEqual(
      commitStops(snap.commitLog, snap.executionTree).map((s) => s.kind),
    );
  });

  it('with and without the execution tree, a real run reads the same axis (9.38.0 misread a one-child fork as a mount)', async () => {
    const chart = flowChart<L>('Seed', async () => undefined, 'seed')
      .addListOfFunction([{ id: 'only', name: 'Only', fn: async (s: any) => s.$setValue('x', 1) }])
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const snap = ex.getSnapshot();
    const treeless = commitStops(snap.commitLog);
    expect(treeless.map((s) => s.kind)).toEqual(commitStops(snap.commitLog, snap.executionTree).map((s) => s.kind));
    expect(treeless.find((s) => s.stageId === 'only')?.kind).toBe('commit');
  });
});

describe('without the tree, subflowResults names every mount (9.39.0) — the same axis as with the tree', () => {
  const leaf = () => flowChart<L>('Leaf', async (s: any) => s.$setValue('x', 1), 'leaf').build();
  const CASES: ReadonlyArray<readonly [string, () => any, string]> = [
    [
      'a mapper-less fork child',
      () =>
        flowChart<L>('Seed', async () => undefined, 'seed')
          .addSubFlowChart('fk', leaf(), 'Fk')
          .addSubFlowChart('fk2', leaf(), 'Fk2'),
      'fk',
    ],
    [
      'a mapper-less selector child',
      () =>
        flowChart<L>('Seed', async () => undefined, 'seed')
          .addSelectorFunction('Pick', () => ['sel'], 'pick')
          .addSubFlowChartBranch('sel', leaf(), 'Sel')
          .end(),
      'sel',
    ],
    [
      'a linear lazy mount',
      () => flowChart<L>('Seed', async () => undefined, 'seed').addLazySubFlowChartNext('lazy', leaf, 'Lazy'),
      'lazy',
    ],
    [
      'a parallelForEach branch',
      () =>
        flowChart<L>('Seed', async (s: any) => s.$setValue('items', [1, 2]), 'seed').addParallelForEach(
          'Each',
          'each',
          {
            items: (s: any) => s.items,
            branch: () => leaf(),
            into: 'out',
            maxBranches: 4,
          },
        ),
      'each~0',
    ],
  ];

  it.each(CASES)('%s', async (_, build, stageId) => {
    const ex = new FlowChartExecutor(build().build());
    await ex.run();
    const snap = ex.getSnapshot();
    const kinds = (stops: readonly { kind: string; runtimeStageId: string }[]) =>
      stops.map((x) => [x.kind, x.runtimeStageId]);
    const withTree = kinds(commitStops(snap.commitLog, snap.executionTree));
    const treeless = kinds(
      timeTravel({
        commitLog: snap.commitLog,
        initialState: snap.initialState,
        subflowResults: snap.subflowResults,
      } as never).stops,
    );
    expect(treeless).toEqual(withTree);
    expect(treeless.find(([, id]) => id.startsWith(`${stageId}#`))?.[0]).toBe('mount');
  });
});

// ── Readers ───────────────────────────────────────────────────────────────

describe('readers group by runtimeStageId and read phase', () => {
  it('a repeat CARRYING a write is attributed to its own stage — a commit, not a mount', () => {
    const log = [
      bundle('a#0', { a: 1 }),
      bundle('c1#1', { x: 1 }),
      bundle('c1#1', { y: 2 }, 'repeat'),
      bundle('b#2', {}),
    ];
    expect(kinds(log)).toEqual([
      ['start', '', -1, -1],
      ['commit', 'a#0', 0, 0],
      ['commit', 'c1#1', 1, 2],
      ['commit', 'b#2', 3, 3],
      ['end', '', 3, 3],
    ]);
    const cursor = timeTravel({ commitLog: log, initialState: {} } as never);
    cursor.jumpTo('c1#1');
    expect(cursor.stateAt().state).toEqual({ a: 1, x: 1, y: 2 });
    expect(cursor.changedSince()).toEqual(['x', 'y']);
    // …and the stage AFTER it does not claim the repeat's write.
    cursor.jumpTo('b#2');
    expect(cursor.changedSince()).toEqual([]);
  });

  it('an interleaved repeat with a write folds where it sits in time; the index anchors each stage at its own bundle', () => {
    const log = [
      bundle('c1#5', { a: 1 }),
      bundle('c2#6', { b: 2 }),
      bundle('c1#5', { y: 3 }, 'repeat'),
      bundle('c2#6', {}, 'repeat'),
    ];
    expect([...buildCommitIndex(log)]).toEqual([
      ['c1#5', 0],
      ['c2#6', 1],
    ]);
    expect(kinds(log).map((k) => k[0])).toEqual(['start', 'commit', 'commit', 'end']);
  });

  it('the same shape WITHOUT phase is a pre-9.39 log: the one legacy reader infers what 9.38.0 inferred', () => {
    const legacy = [bundle('a#0', { a: 1 }), bundle('c1#1', { x: 1 }), bundle('c1#1', { y: 2 }), bundle('b#2', {})];
    expect(recordsPhases(legacy)).toBe(false);
    expect(inferLegacyPhases(legacy)).toEqual([undefined, undefined, 'exit', undefined]);
    // 9.38.0's reading, kept for a stored recording: adjacent pair ⇒ mount.
    expect(kinds(legacy)[2][0]).toBe('mount');
    // With its tree, an old log is never inferred: the tree names the mounts.
    const tree = { id: 'a', runtimeStageId: 'a#0', logs: {}, errors: {}, metrics: {}, evals: {} };
    expect(kinds(legacy, tree as never)[2][0]).toBe('commit');
  });

  it('legacy inference: a later, non-adjacent bundle of the same stage is a repeat', () => {
    const legacy = [bundle('c1#5', { a: 1 }), bundle('c2#6', {}), bundle('c1#5', {}), bundle('c2#6', {})];
    expect(inferLegacyPhases(legacy)).toEqual([undefined, undefined, 'repeat', 'repeat']);
  });

  it('no reader in src infers grouping from the log shape (the looksLikeMount heuristic is gone)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && readFileSync(path, 'utf8').includes('looksLikeMount')) offenders.push(path);
      }
    };
    walk(join(__dirname, '../../../../src'));
    expect(offenders).toEqual([]);
  });
});

// ── Throttling (R9) ─────────────────────────────────────────────────────

describe('throttling is a flow event, end to end', () => {
  const chart = () =>
    flowChart<L>('Root', async (s: any) => s.$setValue('r', 1), 'root')
      .addListOfFunction([
        { id: 'ok', name: 'Ok', fn: async (s: any) => s.$setValue('ok', 1) },
        {
          id: 'thr',
          name: 'Thr',
          fn: async () => {
            throw new Error('429 rate limited');
          },
        },
        {
          id: 'bad',
          name: 'Bad',
          fn: async () => {
            throw new Error('plain failure');
          },
        },
      ])
      .addFunction('Join', async () => undefined, 'join')
      .build();
  const checker = (e: unknown) => e instanceof Error && e.message.startsWith('429');

  it('fires onThrottled once, for the throttled child only, inline and deferred alike', async () => {
    const inline: FlowThrottledEvent[] = [];
    const deferred: FlowThrottledEvent[] = [];
    const ex = new FlowChartExecutor(chart(), { throttlingErrorChecker: checker });
    ex.attachFlowRecorder({ id: 'inline', onThrottled: (e) => inline.push(e) } as FlowRecorder);
    ex.attachFlowRecorder({ id: 'deferred', onThrottled: (e) => deferred.push(e) } as FlowRecorder, {
      delivery: 'deferred',
    });
    await ex.run();
    await ex.drainObservers();

    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ stageName: 'Thr', stageId: 'thr', message: '429 rate limited', channel: 'flow' });
    expect(inline[0].structuredError.name).toBe('Error');
    // The fork's stamp: the fan-out is where the classification is made.
    expect(inline[0].traversalContext?.stageId).toBe('root');
    expect(inline[0].traversalContext?.runId).toBeTruthy();
    expect(deferred.map((e) => e.stageId)).toEqual(['thr']);
  });

  it('writes NO state key: not in state, not in the log, not in the child’s stageWrites', async () => {
    const ex = new FlowChartExecutor(chart(), { throttlingErrorChecker: checker });
    await ex.run();
    const snap = ex.getSnapshot();
    expect((snap.sharedState as L).monitor).toBeUndefined();
    expect(JSON.stringify(snap.commitLog)).not.toContain('isThrottled');
    expect(JSON.stringify(snap.executionTree)).not.toContain('isThrottled');
  });

  it('without a checker, nothing fires', async () => {
    const seen: unknown[] = [];
    const ex = new FlowChartExecutor(chart());
    ex.attachFlowRecorder({ id: 'r', onThrottled: (e) => seen.push(e) } as FlowRecorder);
    await ex.run();
    expect(seen).toEqual([]);
  });
});
