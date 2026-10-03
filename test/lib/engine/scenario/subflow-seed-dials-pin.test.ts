/**
 * A subflow's SEED commit (`history[0]`) under each of the four dials — pinned as of 9.30.0.
 *
 * Why this file exists. `SubflowExecutor.executeSubflow` seeds the nested runtime
 * (`seedSubflowGlobalStore` → one root-context commit, the subflow's `history[0]`) and only
 * THEN pushes the parent's dials into the final nested root (`useReadTracking` /
 * `useWriteTracking` / `useCommitValues` / `useWriteProvenance`). So today the seed bundle is
 * the same bytes under every dial, while the dials do govern every LATER commit of the
 * subflow. The same holds on a resumed leg, where the seed is the pause-time capture.
 *
 * The run-policy packet (one policy object, installed before the seed) will change this ON
 * PURPOSE: under `writeProvenance: 'reads-prefix'` the seed rows gain `readKeys: []` (the one
 * named change); under the other three dials the seed is expected to stay equal. This pin makes
 * that visible — when it lands, the `SEED_*` literals below are re-pinned with every moved leaf
 * named, never silently. They are the bytes the published package (`footprintjs-baseline`, the
 * differential tests' control) commits too.
 *
 * Test types: Scenario (a run, and a pause + resume on a fresh executor — per dial) ·
 * Regression (the pinned bytes) · Integration (the dial IS in force on the commit after the
 * seed — otherwise "the seed is unaffected" would pass vacuously).
 */
import * as baseline from 'footprintjs-baseline';
import { describe, expect, it } from 'vitest';

import type { FlowChartExecutorOptions, PausableHandler } from '../../../../src';
import * as current from '../../../../src';
import type { CommitBundle } from '../../../../src/lib/memory/types';
import { DELIM } from '../../../../src/lib/memory/utils';

type S = Record<string, unknown>;

/** The library under test — the build, or the published package the differential tests use as control. */
type Lib = Pick<typeof current, 'flowChart' | 'FlowChartExecutor' | 'getSubtreeSnapshot'>;
const CURRENT: Lib = current;
const PUBLISHED = baseline as unknown as Lib;

// ── the fixture: a subflow seeded with a scalar, a nested object, an array and a boolean ──

const INPUT = { n: 1, cfg: { a: 1, b: { c: 2 } }, list: [1, 2], flag: true };

type Scope = S & { $getValue: (k: string) => unknown };

/** reads the seeded `n`; writes `doubled` and starts a `log`. (A seeded key is a read-only input.) */
const start = (scope: Scope) => {
  const n = scope.$getValue('n') as number;
  scope.doubled = n * 2;
  scope.log = [n];
};

/** reads `log`, grows it by one element — base + tail, the shape `commitValues: 'delta'` encodes as an append. */
const grow = (by: number) => (scope: Scope) => {
  scope.log = [...(scope.$getValue('log') as number[]), by];
};

function innerChart(pausing: boolean, lib: Lib) {
  const builder = lib.flowChart<S>('Inner', start as never, 'inner');
  if (!pausing) return builder.addFunction('Grow', grow(2) as never, 'grow').build();
  return builder
    .addPausableFunction(
      'Review',
      {
        execute: async (scope: S) => {
          scope.step = 2;
          return { question: 'ok?' };
        },
        resume: async (scope: Scope, input: unknown) => {
          grow(3)(scope);
          scope.answer = (input as { a: string }).a;
        },
      } as PausableHandler<S, { a: string }>,
      'review',
    )
    .build();
}

function outerChart(pausing: boolean, lib: Lib) {
  return lib
    .flowChart<S>(
      'Outer',
      (scope) => {
        scope.start = 1;
      },
      'outer',
    )
    .addSubFlowChartNext('sf', innerChart(pausing, lib), 'Mount', {
      inputMapper: () => structuredClone(INPUT),
      outputMapper: (out) => ({ doubled: (out as S).doubled }),
    })
    .build();
}

// ── the dials ────────────────────────────────────────────────────────────────

const DIALS: Array<[string, FlowChartExecutorOptions]> = [
  ['defaults', {}],
  ['readTracking: summary', { readTracking: 'summary' }],
  ['readTracking: off', { readTracking: 'off' }],
  ['writeTracking: summary', { writeTracking: 'summary' }],
  ['writeTracking: off', { writeTracking: 'off' }],
  ['commitValues: delta', { commitValues: 'delta' }],
  ['writeProvenance: reads-prefix', { writeProvenance: 'reads-prefix' }],
  [
    'all four at once',
    { readTracking: 'summary', writeTracking: 'summary', commitValues: 'delta', writeProvenance: 'reads-prefix' },
  ],
];

/** The subflow's own commit log after a run that completed it. */
async function firstEntry(options: FlowChartExecutorOptions, lib: Lib = CURRENT): Promise<CommitBundle[]> {
  const executor = new lib.FlowChartExecutor(outerChart(false, lib), options);
  await executor.run();
  return historyOf(executor, lib);
}

/** The resumed leg: pause inside the subflow, then resume on a FRESH executor carrying the dials. */
async function resumedLeg(options: FlowChartExecutorOptions, lib: Lib = CURRENT): Promise<CommitBundle[]> {
  const paused = new lib.FlowChartExecutor(outerChart(true, lib), options);
  await paused.run();
  const checkpoint = JSON.parse(JSON.stringify(paused.getCheckpoint()));
  const fresh = new lib.FlowChartExecutor(outerChart(true, lib), options);
  await fresh.resume(checkpoint, { a: 'yes' });
  return historyOf(fresh, lib);
}

function historyOf(executor: current.FlowChartExecutor, lib: Lib = CURRENT): CommitBundle[] {
  const sub = lib.getSubtreeSnapshot(executor.getSnapshot(), 'sf') as { history?: CommitBundle[] } | undefined;
  if (!sub?.history) throw new Error('the subflow left no commit log');
  return sub.history;
}

const bytes = (bundle: CommitBundle) => JSON.stringify(bundle);

/** The execution-tree node of a stage, by id. */
function stageNode(node: any, id: string): any {
  if (!node) return undefined;
  if (node.id === id) return node;
  return stageNode(node.next, id) ?? (node.children ?? []).map((c: any) => stageNode(c, id)).find(Boolean);
}

async function firstEntryRun(options: FlowChartExecutorOptions) {
  const executor = new CURRENT.FlowChartExecutor(outerChart(false, CURRENT), options);
  await executor.run();
  return CURRENT.getSubtreeSnapshot(executor.getSnapshot(), 'sf') as any;
}

// ── the pinned bytes (9.30.0) ────────────────────────────────────────────────

const D = DELIM;

/** Normal entry: the seed is the inputMapper's values. `cfg` spreads into one row per field. */
const SEED_FIRST_ENTRY_PUBLISHED = JSON.stringify({
  overwrite: { n: 1, cfg: { a: 1, b: { c: 2 } }, list: [1, 2], flag: true },
  updates: {},
  redactedPaths: [],
  trace: [
    { path: 'n', verb: 'set' },
    { path: `cfg${D}a`, verb: 'set' },
    { path: `cfg${D}b`, verb: 'set' },
    { path: 'list', verb: 'set' },
    { path: 'flag', verb: 'set' },
  ],
  stage: 'sf/Inner',
  stageId: 'sf/inner',
  runtimeStageId: '',
  idx: 0,
});

/** Resumed leg: the seed is the pause-time capture — everything the subflow had written by then. */
const SEED_RESUMED_PUBLISHED = JSON.stringify({
  overwrite: { n: 1, cfg: { a: 1, b: { c: 2 } }, list: [1, 2], flag: true, doubled: 2, log: [1], step: 2 },
  updates: {},
  redactedPaths: [],
  trace: [
    { path: 'n', verb: 'set' },
    { path: `cfg${D}a`, verb: 'set' },
    { path: `cfg${D}b`, verb: 'set' },
    { path: 'list', verb: 'set' },
    { path: 'flag', verb: 'set' },
    { path: 'doubled', verb: 'set' },
    { path: 'log', verb: 'set' },
    { path: 'step', verb: 'set' },
  ],
  stage: 'sf/Review',
  stageId: 'sf/review',
  runtimeStageId: '',
  idx: 0,
});

/**
 * R13: the seed is the MOUNT's commit, so it carries the mount's names — `stage`, `stageId`,
 * `runtimeStageId` — and nothing else moved. Through 9.33.0 (the published control) it carried the
 * subflow's first stage's names (on a resumed leg: the re-entry stage's) and runtimeStageId ''.
 */
function namedByMount(published: string, runtimeStageId: string): string {
  return JSON.stringify({ ...JSON.parse(published), stage: 'Mount', stageId: 'sf', runtimeStageId });
}
const SEED_FIRST_ENTRY = namedByMount(SEED_FIRST_ENTRY_PUBLISHED, 'sf#1');
const SEED_RESUMED = namedByMount(SEED_RESUMED_PUBLISHED, 'sf#4'); // the mount's execution on the resumed leg

describe('subflow seed (history[0]) — the bytes are the same under every dial, as of 9.30.0', () => {
  describe.each(DIALS)('%s', (_name, options) => {
    it('normal entry: the seed bundle is the pinned bytes', async () => {
      const history = await firstEntry(options);
      expect(bytes(history[0])).toBe(SEED_FIRST_ENTRY);
    });

    it('resumed leg: the seed bundle is the pinned bytes', async () => {
      const history = await resumedLeg(options);
      expect(bytes(history[0])).toBe(SEED_RESUMED);
    });
  });

  it('a same-executor resume seeds the same bytes as a fresh one', async () => {
    const executor = new CURRENT.FlowChartExecutor(outerChart(true, CURRENT), {
      commitValues: 'delta',
      writeProvenance: 'reads-prefix',
    });
    await executor.run();
    await executor.resume(JSON.parse(JSON.stringify(executor.getCheckpoint())), { a: 'yes' });
    expect(bytes(historyOf(executor)[0])).toBe(SEED_RESUMED);
  });

  it('the PUBLISHED package commits the same seed bytes, but for the names R13 moved — the pin is not an accident of this build', async () => {
    expect(bytes((await firstEntry({}, PUBLISHED))[0])).toBe(SEED_FIRST_ENTRY_PUBLISHED);
    expect(bytes((await resumedLeg({}, PUBLISHED))[0])).toBe(SEED_RESUMED_PUBLISHED);
  });

  it('the named leaf the run-policy packet will change: no seed row carries `readKeys` today, even under reads-prefix', async () => {
    const [seed] = await firstEntry({ writeProvenance: 'reads-prefix' });
    expect((seed as any).trace.some((row: any) => row.readKeys !== undefined)).toBe(false);
    const [resumedSeed] = await resumedLeg({ writeProvenance: 'reads-prefix' });
    expect((resumedSeed as any).trace.some((row: any) => row.readKeys !== undefined)).toBe(false);
  });
});

// ── the dials ARE in force — on every commit after the seed ──────────────────
//
// Without this half, "the seed is unaffected" would pass if a dial simply did nothing.

describe('the same dials govern the commits after the seed', () => {
  it('writeProvenance: reads-prefix stamps `readKeys` on the stage rows that follow', async () => {
    const sub = await firstEntryRun({ writeProvenance: 'reads-prefix' });
    expect(sub.history[1].trace).toEqual([
      { path: 'doubled', verb: 'set', readKeys: ['n'] },
      { path: 'log', verb: 'set', readKeys: ['n'] },
    ]);
    expect(sub.history[2].trace).toEqual([{ path: 'log', verb: 'set', readKeys: ['log'] }]);
  });

  it('commitValues: delta commits the growing array as an append of its tail', async () => {
    const full = await firstEntryRun({});
    expect(full.history[2].trace).toEqual([{ path: 'log', verb: 'set' }]);
    expect(full.history[2].overwrite).toEqual({ log: [1, 2] });
    const delta = await firstEntryRun({ commitValues: 'delta' });
    expect(delta.history[2].trace).toEqual([{ path: 'log', verb: 'append' }]);
    expect(delta.history[2].overwrite).toEqual({ log: [2] });
  });

  it('readTracking: summary records a read as a marker; off records none', async () => {
    const summary = await firstEntryRun({ readTracking: 'summary' });
    expect(stageNode(summary.executionTree, 'sf/inner').stageReads).toEqual({
      n: { __readSummary: true, type: 'number', preview: '1' },
    });
    const off = await firstEntryRun({ readTracking: 'off' });
    expect(stageNode(off.executionTree, 'sf/inner').stageReads ?? {}).toEqual({});
  });

  it('writeTracking: summary records a write as a marker; off records none', async () => {
    const summary = await firstEntryRun({ writeTracking: 'summary' });
    expect(stageNode(summary.executionTree, 'sf/inner').stageWrites).toEqual({
      doubled: { __writeSummary: true, type: 'number', preview: '2' },
      log: { __writeSummary: true, type: 'array', size: 1 },
    });
    const off = await firstEntryRun({ writeTracking: 'off' });
    expect(stageNode(off.executionTree, 'sf/inner').stageWrites ?? {}).toEqual({});
  });
});
