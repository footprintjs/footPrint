/**
 * The commit log cannot be edited through what it serves (9.44.2) — one test per door.
 *
 * `Object.freeze` cannot seal a Date's time, a Map's or Set's entries, a buffer's bytes, a RegExp
 * (`compile()` rewrites a frozen one) or an Error's stack. Until 9.44.2 every snapshot shared the
 * log's own frozen bundles and the run's frozen fold base, so `snapshot.commitLog[i].overwrite.when
 * .setTime(0)` — or `.set()` on a Map — rewrote what every later snapshot, `stateAt`,
 * `commitValueAt`, slice and cursor returned. Now a record holding such a value is SERVED as a copy
 * of its open paths (`capture/freeze.ts · serveRecord`): the holder edits only its own copy.
 *
 *   security  per door — `getSnapshot().commitLog`, `.initialState`, `EventLog.list()` on
 *             `footprintjs/advanced` — every mutation a holder can try (test/helpers/valueKinds.ts ·
 *             vandalize) lands on its own copy, and the next serve and every reader read the record
 *             as recorded; the engine's own read (`EventLog.recorded()`) is the log itself, unserved
 *   security  a reader's own answer — `commitValueAt` (its memo: an edit of one answer changed the
 *             next), `stateAt`, the cursor — is the caller's: editing it changes no later answer
 *   boundary  the pause checkpoint and the dev-mode `sharedState` are fresh copies already
 *   unit      a record freezing seals whole is served as itself: no copy, the same object every time
 *
 * Not a door of this release (the served-surface law, with the record-frame clean-up C3/C4): a
 * subflow's stored results, the execution tree, recorder rows, `getCheckpoint()` identity, the
 * narrative entries.
 */
import v8 from 'node:v8';

import type { CommitBundle } from '../../../../src';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../../src';
import { EventLog } from '../../../../src/advanced';
import { arrayProvenance, commitValueAt, stateAt, timeTravel } from '../../../../src/trace';
import { vandalize } from '../../../helpers/valueKinds';

/** Every value freezing cannot seal, plus a JSON key beside them. */
const unsealable = () => ({
  when: new Date(1000),
  tags: new Map([['k', { v: 1 }]]),
  seen: new Set(['a']),
  re: /a/g,
  err: new Error('boom', { cause: new Date(7) }),
  buf: new Uint8Array([1, 2, 3]).buffer,
  bytes: new Uint8Array([4, 5, 6]),
  view: new DataView(new Uint8Array([7, 8]).buffer),
  list: [new Date(2), { at: new Date(3) }],
});

const inner = flowChart(
  'Inner',
  (scope: any) => {
    scope.$setValue('found', new Date(42));
    scope.$setValue('found2', new Map([['x', 1]]));
  },
  'inner',
).build();

async function run() {
  const chart = flowChart(
    'Seed',
    (scope: any) => {
      scope.$setValue('rec', unsealable());
      scope.plain = { n: 1 };
    },
    'seed',
  )
    .addFunction(
      'Again',
      (scope: any) => {
        scope.$setValue('when', new Date(9));
      },
      'again',
    )
    .addSubFlowChartNext('sub', inner, 'Sub', {
      inputMapper: () => ({}),
      outputMapper: (out: any) => ({ found: out.found }),
    })
    .build();
  const executor = new FlowChartExecutor(chart, { initialContext: { base: unsealable() } });
  await executor.run();
  return executor;
}

/** Every answer the record gives, as bytes — read from a FRESH snapshot. */
function answers(executor: FlowChartExecutor): string {
  const snap = executor.getSnapshot();
  const log = snap.commitLog as CommitBundle[];
  const keys = ['rec', 'when', 'plain', 'found', 'base'];
  const cursor = timeTravel(snap);
  const sub = getSubtreeSnapshot(snap, 'sub');
  const all = {
    log,
    base: snap.initialState,
    states: log.map((_, i) => stateAt(snap, i).state),
    values: keys.map((k) => log.map((_, i) => commitValueAt(log, i, k))),
    list: arrayProvenance(log, 'rec\u001flist').births?.map((b) => b.value),
    cursor: cursor.stateAt(cursor.stops[cursor.stops.length - 1]).state,
    sub: sub && {
      history: sub.history,
      base: sub.initialState,
      state: stateAt(sub, (sub.history?.length ?? 0) - 1).state,
    },
  };
  return v8.serialize(all).toString('hex');
}

describe('the commit log cannot be edited through what it serves (9.44.2)', () => {
  it('getSnapshot().commitLog: every edit lands on the holder’s copy', async () => {
    const executor = await run();
    const before = answers(executor);
    const snap = executor.getSnapshot();
    // the reported repro, first
    (snap.commitLog[0].overwrite.rec as { when: Date }).when.setTime(0);
    (snap.commitLog[0].overwrite.rec as { tags: Map<string, unknown> }).tags.set('k', 'forged');
    expect(vandalize(snap.commitLog)).toBeGreaterThan(0);
    expect(answers(executor)).toBe(before);
  });

  it('getSnapshot().initialState (the fold base)', async () => {
    const executor = await run();
    const before = answers(executor);
    const snap = executor.getSnapshot();
    (snap.initialState!.base as { when: Date }).when.setTime(0);
    expect(vandalize(snap.initialState)).toBeGreaterThan(0);
    expect(answers(executor)).toBe(before);
  });

  it('EventLog.list() on footprintjs/advanced serves its bundles the same way', () => {
    const log = new EventLog({});
    log.record({
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'when', verb: 'set' }],
      overwrite: { when: new Date(5), m: new Map([['k', 1]]) },
      updates: {},
      redactedPaths: [],
    });
    const served = log.list()[0];
    (served.overwrite.when as Date).setTime(0);
    (served.overwrite.m as Map<string, number>).set('k', 2);
    const again = log.list()[0];
    expect((again.overwrite.when as Date).getTime()).toBe(5);
    expect((again.overwrite.m as Map<string, number>).get('k')).toBe(1);
    expect(log.materialise().when.getTime()).toBe(5);
  });

  it('the engine’s own read is not served: recorded() is the log’s own array, so the run path copies nothing', () => {
    const log = new EventLog({});
    const bundle: CommitBundle = {
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'when', verb: 'set' }],
      overwrite: { when: new Date(5) },
      updates: {},
      redactedPaths: [],
    } as CommitBundle;
    log.record(bundle);
    expect(log.recorded()[0]).toBe(bundle); // the engine's (ExecutionRuntime · getSnapshot, per subflow mount)
    expect(log.list()[0]).not.toBe(bundle); // a reader's: a copy of its open paths
    expect(log.recorded()).toBe(log.recorded());
  });
});

describe('the door is iterative: a bundle 20,000 deep (9.44.2)', () => {
  it('EventLog.list() seals and serves it without a recursion; an edit of the served copy reaches nothing', () => {
    let deep: Record<string, unknown> = { at: new Date(5) };
    for (let i = 0; i < 20_000; i++) deep = { next: deep };
    const log = new EventLog({});
    log.record({
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'deep', verb: 'set' }],
      overwrite: { deep },
      updates: {},
      redactedPaths: [],
    });
    const bottom = (bundle: CommitBundle) => {
      let at = bundle.overwrite.deep as Record<string, unknown>;
      while (at.next !== undefined) at = at.next as Record<string, unknown>;
      return at.at as Date;
    };
    bottom(log.list()[0]).setTime(0); // the reader's copy, 20,000 down
    expect(bottom(log.list()[0]).getTime()).toBe(5);
  });
});

describe('a reader’s answer is the caller’s own: editing it changes no later answer', () => {
  it('commitValueAt on an engine log (memoised) — a nested key folded from a kept generation', () => {
    // `cfg` is set whole, then `cfg␟a` is set: the memo keeps the generation after commit 0, and
    // `cfg␟a` at commit 0 is folded from it. Until 9.44.2 the answer WAS the memo.
    const log = new EventLog({});
    const bundle = (i: number, path: string, overwrite: Record<string, unknown>): CommitBundle => ({
      stage: `S${i}`,
      stageId: `s${i}`,
      runtimeStageId: `s${i}#${i}`,
      trace: [{ path, verb: 'set' }],
      overwrite,
      updates: {},
      redactedPaths: [],
    });
    log.record(bundle(0, 'cfg', { cfg: { a: { x: 1 } } }));
    log.record(bundle(1, 'cfg\u001fa', { cfg: { a: { x: 2 } } }));
    const frozenLog = Object.freeze(log.list());
    const first = commitValueAt(frozenLog, 0, 'cfg\u001fa') as { x: number };
    first.x = 99;
    expect(commitValueAt(frozenLog, 0, 'cfg\u001fa')).toEqual({ x: 1 });
  });

  it('commitValueAt, stateAt and the cursor, on a snapshot of a run', async () => {
    const executor = await run();
    const snap = executor.getSnapshot();
    const log = snap.commitLog as CommitBundle[];
    const read = () =>
      v8
        .serialize([
          commitValueAt(log, 0, 'rec'),
          stateAt(snap, 1).state,
          timeTravel(snap).stateAt().state,
          getSubtreeSnapshot(snap, 'sub')?.initialState,
        ])
        .toString('hex');
    const before = read();
    vandalize([commitValueAt(log, 0, 'rec'), stateAt(snap, 1).state, timeTravel(snap).stateAt().state]);
    expect(read()).toBe(before);
  });
});

describe('the copies that already were: checkpoint and dev-mode sharedState', () => {
  it('editing a pause checkpoint changes nothing the paused executor serves', async () => {
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.$setValue('rec', unsealable());
      },
      'seed',
    )
      .addPausableFunction('Ask', { execute: () => ({ question: 'ok?' }), resume: () => {} }, 'ask')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint = executor.getCheckpoint()!;
    const before = answers(executor);
    expect(vandalize(checkpoint)).toBeGreaterThan(0);
    expect(answers(executor)).toBe(before);
  });

  it('dev mode: the frozen sharedState clone is the caller’s own', async () => {
    enableDevMode();
    try {
      const executor = await run();
      const read = () => v8.serialize(executor.getSnapshot().sharedState.rec).toString('hex');
      const before = read();
      vandalize(executor.getSnapshot().sharedState.rec);
      expect(read()).toBe(before);
    } finally {
      disableDevMode();
    }
  });
});

describe('a record freezing seals whole is served as itself', () => {
  it('the same bundle object on every serve — no copy, no cost', async () => {
    const executor = await run();
    const a = executor.getSnapshot().commitLog;
    const b = executor.getSnapshot().commitLog;
    expect(a[0]).not.toBe(b[0]); // the seed holds values freezing cannot seal: a copy per serve
    const plain = new FlowChartExecutor(
      flowChart(
        'P',
        (scope: any) => {
          scope.k = { n: [1] };
        },
        'p',
      ).build(),
    );
    await plain.run();
    expect(plain.getSnapshot().commitLog[0]).toBe(plain.getSnapshot().commitLog[0]);
    expect(plain.getSnapshot().initialState).toBe(plain.getSnapshot().initialState);
  });
});
