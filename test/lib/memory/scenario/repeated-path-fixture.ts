/**
 * The repeated-path fixture behind `repeated-path-byte-identity.test.ts`.
 *
 * 9.22.1 makes two hot loops skip work a LATER op on the same path makes
 * redundant — the commit-side materialisation in
 * `TransactionBuffer.toChangeOnlyPayload` and the replay-side `set` arm in
 * `applySmartMerge`. Neither may change a byte of what is recorded or what a
 * fold answers. This fixture is the evidence: every shape the skips can meet
 * — the same path `set` many times in one stage (the 9.22.0 element-write
 * funnel), `set` interleaved with `merge` on one path, `delete` then re-set,
 * repeated `merge`, repeated `append`, a write-then-revert, and nested paths
 * whose ancestor is written in the same commit — run under BOTH commit-log
 * encodings, projected to the bytes a consumer keeps: the commit log, the
 * final state, the fold at EVERY stop (`stateAt`) and every key's
 * `commitValueAt` at every index.
 *
 * Two halves, because user-level writes reach the buffer through the scope
 * (top-level paths, `set` of the ROOT key for arrays) while nested paths
 * reach it only through the engine (a subflow seed, an `outputMapper`):
 *   - `runRepeatedPathChart` — a real run through `FlowChartExecutor`;
 *   - `runRepeatedPathBuffer` — `TransactionBuffer` driven directly with the
 *     nested / ancestor / descendant sequences the chart cannot spell, folded
 *     by `applySmartMerge` and `EventLog.materialise`.
 *
 * `shellJSON` keeps an own `undefined` VISIBLE (as a sentinel string) — the
 * historical `'full'` flattening of a delete is `key: undefined`, which plain
 * JSON would hide, and a skip that dropped or grew such a shell must fail.
 */

import type { CommitValuesMode, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { EventLog } from '../../../../src/lib/memory/EventLog.js';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer.js';
import type { CommitBundle } from '../../../../src/lib/memory/types.js';
import { applySmartMerge } from '../../../../src/lib/memory/utils.js';
import { commitValueAt, stateAt } from '../../../../src/trace.js';

const VOLATILE_KEYS = new Set(['timestamp', 'runId', 'pipelineId', 'durationMs', 'duration', 'startTime', 'endTime']);
const UNDEFINED_SHELL = '«undefined»';

/** JSON with volatile fields dropped and an own `undefined` kept visible. */
export function shellJSON(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v) => (VOLATILE_KEYS.has(key) ? undefined : v === undefined ? UNDEFINED_SHELL : v),
    2,
  );
}

interface Line {
  id: number;
  n: number;
}

interface InnerState {
  profile: { name: string; auth: { token: string } };
  tags: string[];
  summary: string;
  local: string[];
}

interface State {
  k: { arr: Line[]; other: number };
  list: number[];
  obj: { a: number; b?: number; c?: number };
  temp?: string;
  n: number;
  flip: string;
  profile: { name: string; auth: { token: string }; seen?: boolean };
  tags: string[];
  summary: string;
  when: Date;
}

const ELEMENTS = 6;

function buildChart() {
  const inner = flowChart<InnerState>(
    'Inner',
    (scope: TypedScope<InnerState>) => {
      // Repeated top-level sets inside the subflow, on top of its nested
      // seed (`profile.name`, `profile.auth` are seeded as NESTED paths).
      scope.summary = `${scope.profile.name}:${scope.tags.length}`;
      scope.summary = `${scope.summary}!`;
      scope.local = ['a', 'b', 'c'];
      scope.local = ['a', 'b', 'c', 'd'];
    },
    'inner',
  ).build();

  return flowChart<State>(
    'Seed',
    (scope: TypedScope<State>) => {
      scope.k = { arr: Array.from({ length: ELEMENTS }, (_, id) => ({ id, n: 0 })), other: 1 };
      scope.list = [1, 2];
      scope.obj = { a: 1 };
      scope.temp = 't';
      scope.n = 0;
      scope.flip = 'x';
      scope.profile = { name: 'Ada', auth: { token: 'tok-1' } };
      scope.tags = ['z'];
      scope.$setValue('when', new Date(Date.UTC(2020, 0, 1)));
    },
    'seed',
  )
    .addFunction(
      'RepeatSet',
      (scope: TypedScope<State>) => {
        // N element writes on ONE path → N whole-array `set` rows on `k`
        // (the 9.22.0 funnel the skips exist for). Element 0 keeps its value:
        // the FIRST row's net-change verdict is decided by a later element.
        const arr = scope.k.arr;
        for (let i = 0; i < ELEMENTS; i++) arr[i].n = i;
        // Repeated scalar set — the last value wins.
        scope.n = 1;
        scope.n = 2;
        // Write-then-revert — must drop out of the bundle entirely.
        scope.flip = 'y';
        scope.flip = 'x';
        // Repeated push — two `set` rows in 'full', one `append` in 'delta'.
        scope.list.push(3);
        scope.list.push(4);
        // Repeated merge on one path.
        scope.$update('obj', { b: 2 });
        scope.$update('obj', { c: 3 });
        scope.$update('obj', { b: 4 });
      },
      'repeat-set',
    )
    .addFunction(
      'Mixed',
      (scope: TypedScope<State>) => {
        // `set` (element write) interleaved with `merge` (object field write)
        // on the SAME root key — the mixed-verb interleaving both encoders
        // must keep reproducing exactly.
        scope.k.arr[0].n = 100;
        scope.k.other = 2;
        scope.k.arr[1].n = 101;
        scope.k.other = 3;
        scope.k.arr[1].n = 102;
        // delete, re-set, delete again, and a delete of an absent key.
        scope.$delete('temp');
        scope.temp = 'again';
        scope.$delete('temp');
        scope.$delete('n');
        scope.n = 9;
        scope.n = 10;
        scope.$setValue('when', new Date(Date.UTC(2021, 5, 1)));
        scope.$setValue('when', new Date(Date.UTC(2022, 5, 1)));
      },
      'mixed',
    )
    .addFunction(
      'ReadOnly',
      (scope: TypedScope<State>) => {
        if (scope.k.arr.length < 0) throw new Error('unreachable');
      },
      'read-only',
    )
    .addSubFlowChartNext('sf', inner, 'Sub', {
      inputMapper: (parent: State) => ({ profile: parent.profile, tags: parent.tags }),
      outputMapper: (out: InnerState) => ({ summary: out.summary, tags: ['y'], profile: { seen: true } }),
    })
    .addFunction(
      'Again',
      (scope: TypedScope<State>) => {
        scope.k.arr[ELEMENTS - 1].n = 200;
        scope.k.arr[ELEMENTS - 1].n = 201;
        scope.list = [];
        scope.list = [7];
        scope.$update('obj', { a: 1 }); // no-op merge — drops out
      },
      'again',
    )
    .build();
}

/** Every key's `commitValueAt` at every commit index, plus the fold at every stop. */
function foldEverything(snapshot: { commitLog: CommitBundle[]; initialState?: unknown }) {
  const keys = new Set<string>();
  for (const bundle of snapshot.commitLog) for (const row of bundle.trace) keys.add(row.path);
  const sortedKeys = [...keys].sort();
  const folds: Array<{ idx: number; state: unknown; values: Record<string, unknown> }> = [];
  for (let idx = -1; idx < snapshot.commitLog.length; idx++) {
    const values: Record<string, unknown> = {};
    for (const key of sortedKeys) values[key] = idx < 0 ? undefined : commitValueAt(snapshot.commitLog, idx, key);
    folds.push({ idx, state: stateAt(snapshot as never, idx).state, values });
  }
  return folds;
}

/** Run the chart under one commit-log encoding and return its stable bytes. */
export async function runRepeatedPathChart(commitValues: CommitValuesMode): Promise<string> {
  const executor = new FlowChartExecutor(buildChart(), { commitValues });
  await executor.run();
  const snapshot = executor.getSnapshot();
  const mount = (snapshot.subflowResults?.sf as { treeContext?: { history?: CommitBundle[]; initialState?: unknown } })
    ?.treeContext;
  return shellJSON({
    sharedState: snapshot.sharedState,
    initialState: snapshot.initialState,
    commitValues: snapshot.commitValues,
    commitLog: snapshot.commitLog,
    folds: foldEverything(snapshot),
    subflow: mount && {
      history: mount.history,
      initialState: mount.initialState,
      folds: foldEverything({ commitLog: mount.history ?? [], initialState: mount.initialState }),
    },
  });
}

type Op = ['set' | 'merge' | 'delete', (string | number)[], unknown?];

/**
 * The buffer-level sequences: nested paths beside their ancestor, repeated
 * at every position a skip could fire — before, between and after the
 * ancestor write — plus repeats through a primitive intermediate that
 * `nativeSet` coerces, and repeats whose final value is `undefined`.
 */
const BUFFER_STAGES: ReadonlyArray<{ name: string; ops: Op[] }> = [
  {
    name: 'nested-then-ancestor',
    ops: [
      ['set', ['a', 'b'], { x: 1 }],
      ['set', ['a', 'b'], { x: 2 }],
      ['set', ['a'], { c: 1 }],
      ['set', ['a', 'b'], { x: 3 }],
      ['set', ['a'], { c: 2, b: { x: 4 } }],
      ['set', ['a', 'b'], { x: 5 }],
    ],
  },
  {
    name: 'ancestor-then-nested',
    ops: [
      ['set', ['a'], { c: 9 }],
      ['set', ['a', 'b'], [1]],
      ['set', ['a', 'b'], [1, 2]],
      ['set', ['a', 'd'], 'd'],
      ['set', ['a'], { c: 10, b: [1, 2, 3], d: 'd' }],
      ['set', ['a'], { c: 11, b: [1, 2, 3], d: 'd' }],
    ],
  },
  {
    name: 'set-merge-interleaved',
    ops: [
      ['set', ['o'], { p: 1 }],
      ['merge', ['o'], { q: 2 }],
      ['set', ['o'], { p: 3 }],
      ['merge', ['o'], { r: 4 }],
      ['set', ['o'], { p: 5 }],
      ['set', ['o'], { p: 6 }],
      ['merge', ['o', 'deep'], { s: 7 }],
      ['merge', ['o', 'deep'], { t: 8 }],
    ],
  },
  {
    name: 'delete-shapes',
    ops: [
      ['set', ['gone'], 1],
      ['delete', ['gone']],
      ['delete', ['gone']],
      ['set', ['keep'], 1],
      ['delete', ['keep']],
      ['set', ['keep'], 2],
      ['set', ['keep'], 3],
      ['delete', ['nested', 'leaf']],
      ['set', ['nested', 'leaf'], 'back'],
      ['set', ['nested', 'leaf'], undefined],
      ['set', ['nested', 'leaf'], undefined],
      ['delete', ['prim', 'under']], // parent is a primitive in the base
      ['set', ['prim', 'under'], 1],
      ['set', ['prim', 'under'], 2],
    ],
  },
  {
    name: 'revert-and-noop',
    ops: [
      ['set', ['keep'], 3],
      ['set', ['keep'], 99],
      ['set', ['keep'], 3],
      ['set', ['list'], [1, 2, 3]],
      ['set', ['list'], [1, 2, 3, 4]],
      ['set', ['list'], [1, 2, 3, 4, 5]],
      ['merge', ['o'], { p: 6 }],
      ['set', ['fresh'], { a: [1] }],
      ['set', ['fresh', 'a'], [1, 2]],
      ['set', ['fresh', 'a'], [1, 2]],
    ],
  },
];

/** Drive `TransactionBuffer` directly and return the stable bytes of log + folds. */
export function runRepeatedPathBuffer(commitValues: CommitValuesMode): string {
  const base = { prim: 5, list: [1, 2], keep: 1, o: { p: 0 }, nested: { leaf: 'seed', other: 1 } };
  const log = new EventLog(base);
  let live: Record<string, unknown> = structuredClone(base);
  const bundles: unknown[] = [];
  for (const [i, stage] of BUFFER_STAGES.entries()) {
    const buffer = new TransactionBuffer(live, commitValues);
    for (const [verb, path, value] of stage.ops) {
      // The buffer keeps the RAW reference it is handed (landmine 3), so a
      // later nested op would write INTO the fixture literal — clone per op.
      if (verb === 'set') buffer.set(path, structuredClone(value));
      else if (verb === 'merge') buffer.merge(path, structuredClone(value));
      else buffer.delete(path);
    }
    const payload = buffer.commit();
    live = applySmartMerge(live, payload.updates, payload.overwrite, payload.trace);
    const bundle: CommitBundle = {
      ...payload,
      redactedPaths: [...payload.redactedPaths],
      stage: stage.name,
      stageId: stage.name,
      runtimeStageId: `${stage.name}#${i + 1}`,
    };
    log.record(bundle);
    bundles.push(bundle);
  }
  const commitLog = log.list();
  return shellJSON({
    commitValues,
    base,
    live,
    commitLog: bundles,
    materialised: commitLog.map((_, i) => log.materialise(i + 1)),
    folds: foldEverything({ commitLog, initialState: base }),
  });
}
