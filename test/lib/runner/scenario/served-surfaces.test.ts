/**
 * THE CLASS — nothing the library serves can be edited through what it serves (9.45.0).
 *
 * One test for every served surface, found by WALKING, not listed: every field of `getSnapshot()` and
 * `getSnapshot({ redact: true })` — the commit log, the fold base, the execution tree (its retained
 * reads and writes, its diagnostics, its flow messages), the subflow results (history, base, the
 * subflow's own tree, the chart structure), the recorder rows (the narrative's among them) — plus
 * `getSubtreeSnapshot`, `getSubflowResults()`, `getNarrativeEntries()` and the pause checkpoint. Every
 * value reached — objects, arrays, Dates, Maps, Sets, buffers, views, errors, RegExps — takes every
 * mutation a holder can try (test/helpers/valueKinds.ts · vandalize). Then a FRESH serve of each, and
 * every reader (`stateAt`, `commitValueAt`, the slices, the cursor), returns exactly what it did before.
 *
 * A field added to any of these later is walked without anyone listing it (`every served field is
 * walked` proves the walk reached each top-level field). The only values NOT walked are the documented
 * LIVE views, named in `LIVE` and pinned live below: `sharedState` (the run's heap — dev mode serves a
 * frozen clone instead; a subtree's `sharedState` is its subflow's heap), a subflow's
 * `treeContext.globalContext` (its heap, or its live mirror under `redact`) and a narrative entry's
 * `rawValue` (a live reference to the scope value, by contract).
 */
import v8 from 'node:v8';

import type { CommitBundle, PausableHandler, RuntimeSnapshot } from '../../../../src';
import { decide, flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../../src';
import { metrics, narrative } from '../../../../src/recorders';
import {
  arrayProvenance,
  commitValueAt,
  forwardSliceForKey,
  keysReadFromExecutionTree,
  keyTimeline,
  sliceForKey,
  stateAt,
  timeTravel,
} from '../../../../src/trace';
import { type VandalPath, vandalize } from '../../../helpers/valueKinds';

/** The documented LIVE views — the only values the walk leaves alone (paths relative to each surface). */
const LIVE = (path: VandalPath): boolean =>
  path[0] === 'sharedState' ||
  path[path.length - 1] === 'rawValue' ||
  (path[path.length - 1] === 'globalContext' && path[path.length - 2] === 'treeContext');

/** Every kind a record can hold, nested. */
const everyKind = () => ({
  when: new Date(1000),
  map: new Map([['k', { v: 1 }]]),
  set: new Set(['a']),
  re: /a/g,
  err: new Error('boom', { cause: { c: 1 } }),
  buf: new Uint8Array([1, 2, 3]).buffer,
  bytes: new Uint8Array([4, 5, 6]),
  view: new DataView(new Uint8Array([7, 8]).buffer),
  list: [new Date(2), { at: new Date(3) }],
});

const inner = flowChart(
  'Inner',
  (scope: any) => {
    scope.$getValue('seedNote');
    scope.$setValue('found', { at: new Date(42), tags: new Set(['x']) });
    scope.$debug('inner', { when: new Date(1), list: [1] });
  },
  'inner',
).build();

function chart() {
  return flowChart(
    'Seed',
    (scope: any) => {
      scope.$setValue('rec', everyKind());
      scope.$setValue('secret', 'sk-1');
      scope.plain = { n: 1, items: [{ id: 1 }] };
      scope.$debug('note', { at: new Date(5), list: [1, 2] });
      scope.$metric('count', 3);
    },
    'seed',
  )
    .addFunction(
      'Read',
      (scope: any) => {
        scope.$getValue('rec');
        scope.$getValue('plain');
        scope.$setValue('when', new Date(9));
        scope.$update('plain', { more: { at: new Date(6) } });
        scope.$setValue('items', [new Date(1), new Date(2)]);
      },
      'read',
    )
    .addDeciderFunction(
      'Route',
      (scope: any) => decide(scope, [{ when: { secret: { eq: 'sk-1' } }, then: 'yes' }], 'no'),
      'route',
    )
    .addFunctionBranch('yes', 'Yes', (scope: any) => {
      scope.lane = 'yes';
    })
    .addFunctionBranch('no', 'No', (scope: any) => {
      scope.lane = 'no';
    })
    .setDefault('no')
    .end()
    .addSubFlowChartNext('sub', inner, 'Sub', {
      inputMapper: (parent: any) => ({ seedNote: parent.plain }),
      outputMapper: (out: any) => ({ found: out.found }),
    })
    .build();
}

async function finishedRun() {
  const executor = new FlowChartExecutor(chart(), { initialContext: { base: everyKind() } });
  executor.setRedactionPolicy({ keys: ['secret'] });
  executor.enableNarrative();
  executor.attachCombinedRecorder(narrative());
  executor.attachScopeRecorder(metrics());
  await executor.run();
  return executor;
}

async function pausedRun() {
  const paused = flowChart(
    'Seed',
    (scope: any) => {
      scope.$setValue('rec', everyKind());
    },
    'seed',
  )
    .addPausableFunction(
      'Ask',
      { execute: () => ({ question: 'ok?', at: new Date(7) }), resume: () => {} } as PausableHandler<any>,
      'ask',
    )
    .build();
  const executor = new FlowChartExecutor(paused);
  await executor.run();
  return executor;
}

/** Everything the two executors serve — each a fresh serve. */
function served(run: FlowChartExecutor, paused: FlowChartExecutor) {
  const snapshot = run.getSnapshot();
  return {
    snapshot,
    redacted: run.getSnapshot({ redact: true }),
    subtree: getSubtreeSnapshot(snapshot, 'sub', run.getNarrativeEntries()),
    subflowResults: Object.fromEntries(run.getSubflowResults()),
    narrative: run.getNarrativeEntries(),
    checkpoint: paused.getCheckpoint(),
  };
}

/** What every surface serves and every reader answers, from a fresh serve, as bytes per name — live views left out. */
function answers(run: FlowChartExecutor, paused: FlowChartExecutor): Record<string, string> {
  const all = served(run, paused);
  const log = all.snapshot.commitLog as CommitBundle[];
  const reads = keysReadFromExecutionTree(all.snapshot.executionTree);
  const keys = ['rec', 'when', 'plain', 'items', 'found', 'base', 'lane'];
  const cursor = timeTravel(all.snapshot);
  const bytes = (value: unknown) => v8.serialize(value).toString('hex');
  const out: Record<string, string> = {};
  for (const [name, surface] of Object.entries(all)) {
    for (const [field, value] of Object.entries(surface ?? {}))
      out[`${name}.${field}`] = bytes(withoutLive(value, [field]));
  }
  out.states = bytes(log.map((_, i) => stateAt(all.snapshot, i).state));
  out.values = bytes(keys.map((k) => log.map((_, i) => commitValueAt(log, i, k))));
  out.slices = bytes(
    keys.map((k) => [
      JSON.stringify(sliceForKey(log, k, reads)),
      JSON.stringify(keyTimeline(log, k, reads)),
      JSON.stringify(forwardSliceForKey(log, k, reads)),
    ]),
  );
  out.births = bytes(arrayProvenance(log, 'items').births?.map((b) => b.value));
  out.cursor = bytes(cursor.stops.map((stop) => cursor.stateAt(stop).state));
  return out;
}

/** A copy of `value` with every LIVE view replaced by a marker — what the answers compare. */
function withoutLive(value: unknown, path: VandalPath = [], seen = new Map<object, unknown>()): unknown {
  if (LIVE(path)) return '<live>';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    value.forEach((x, i) => out.push(withoutLive(x, [...path, String(i)], seen)));
    return out;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.keys(value))
    out[key] = withoutLive((value as Record<string, unknown>)[key], [...path, key], seen);
  return out;
}

describe('THE CLASS — nothing the library serves can be edited through what it serves', () => {
  it('every reachable value of every served surface takes every mutation; every later serve and reader is unchanged', async () => {
    const run = await finishedRun();
    const paused = await pausedRun();
    const before = answers(run, paused);

    const surfaces = served(run, paused);
    const visited = new Set<string>();
    let landed = 0;
    for (const [name, surface] of Object.entries(surfaces)) {
      landed += vandalize(surface, {
        skip: LIVE,
        onVisit: (path) => path.length > 0 && visited.add(`${name}.${path[0]}`),
      });
    }

    expect(landed).toBeGreaterThan(100); // the walk did reach mutable copies (it is not vacuous)
    const after = answers(run, paused);
    const changed = Object.keys(before).filter((name) => after[name] !== before[name]);
    expect(changed).toEqual([]);

    // every served field is walked — a field added later is walked without anyone listing it
    for (const [name, surface] of Object.entries(surfaces)) {
      for (const key of Object.keys(surface ?? {})) {
        if (!LIVE([key])) expect(visited.has(`${name}.${key}`), `${name}.${key} walked`).toBe(true);
      }
    }
  });

  it('the snapshot carries every surface the test means to walk (so the walk above is the whole class)', async () => {
    const run = await finishedRun();
    const paused = await pausedRun();
    const { snapshot, subtree, narrative: entries, checkpoint } = served(run, paused);
    const tree = JSON.stringify(snapshot.executionTree);
    expect(snapshot.commitLog.length).toBeGreaterThan(3);
    expect(Object.keys(snapshot.initialState ?? {})).toContain('base');
    expect(tree).toContain('stageReads');
    expect(tree).toContain('stageWrites');
    expect(tree).toContain('flowMessages');
    expect(tree).toContain('note');
    expect((snapshot.recorders ?? []).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(snapshot.subflowResults ?? {}).length).toBeGreaterThan(0);
    expect(subtree?.history?.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
    expect(checkpoint?.sharedState).toBeDefined();
  });

  it('the LIVE views are live by design — documented, not an oversight', async () => {
    const run = await finishedRun();
    const a = run.getSnapshot() as RuntimeSnapshot;
    const b = run.getSnapshot() as RuntimeSnapshot;
    expect(a.sharedState).toBe(b.sharedState); // the run's heap, zero-copy (dev mode: a frozen clone)
    const sub = (s: RuntimeSnapshot) =>
      (Object.values(s.subflowResults ?? {})[0] as { treeContext: { globalContext: unknown } }).treeContext
        .globalContext;
    expect(sub(a)).toBe(sub(b)); // a subflow's heap
    expect(a.commitLog[0]).not.toBe(b.commitLog[0]); // a record holding a Date: a copy per serve
  });
});
