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
 *             `foottrace/write` — every mutation a holder can try (test/helpers/valueKinds.ts ·
 *             vandalize) lands on its own copy, and the next serve and every reader read the record
 *             as recorded; the engine's own read (`EventLog.recorded()`) is the log itself, unserved
 *   security  a reader's own answer — `commitValueAt` (its memo: an edit of one answer changed the
 *             next), `stateAt`, the cursor — is the caller's: editing it changes no later answer
 *   boundary  the pause checkpoint and the dev-mode `sharedState` are fresh copies already
 *   unit      a record freezing seals whole is served as itself: no copy, the same object every time
 *   edge      what a served copy keeps whatever the shape: an own `"__proto__"` key (as DATA, through
 *             every door and reader), a part shared by two holders (both copied), one value held by
 *             150,000 containers (served — no stack overflow — and still copied on the next serve)
 *
 * Not a door of this release (the served-surface law, with the record-frame clean-up C3/C4): a
 * subflow's stored results, the execution tree, recorder rows, `getCheckpoint()` identity, the
 * narrative entries.
 */
import type { CommitBundle } from 'foottrace';
import { arrayProvenance, commitValueAt, stateAt, timeTravel } from 'foottrace';
import { EventLog } from 'foottrace/write';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../../src';
import { recordKey, vandalize } from '../../../helpers/valueKinds';

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

/**
 * Every answer the record gives, keyed by VALUE (test/helpers/valueKinds.ts · recordKey — not `v8.serialize`
 * bytes, which also encode how V8 stores a number) — read from a FRESH snapshot.
 */
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
  return recordKey(all, 'kind');
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
});

describe('what a served copy keeps, whatever the record’s shape (9.44.2 final review)', () => {
  /** A `JSON.parse` payload: its `"__proto__"` is an OWN data key, beside a value freezing cannot seal. */
  const payload = () => {
    const user = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "eve"}');
    user.at = new Date(5);
    return user as Record<string, unknown>;
  };

  it('an own "__proto__" key is served as DATA by every door and every reader — never re-parenting the copy', async () => {
    const expected = recordKey(payload(), 'kind');
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.$setValue('user', payload());
      },
      'seed',
    ).build();
    const executor = new FlowChartExecutor(chart, { initialContext: { seed: payload() } });
    await executor.run();
    const snap = executor.getSnapshot();
    const log = snap.commitLog as CommitBundle[];
    const cursor = timeTravel(snap);
    const eventLog = new EventLog({});
    eventLog.record({
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'user', verb: 'set' }],
      overwrite: { user: payload() },
      updates: {},
      redactedPaths: [],
    });
    const served: Record<string, unknown> = {
      commitLog: log[0].overwrite.user,
      initialState: snap.initialState!.seed,
      'EventLog.list()': eventLog.list()[0].overwrite.user,
      stateAt: stateAt(snap, 0).state.user,
      commitValueAt: commitValueAt(log, 0, 'user'),
      cursor: cursor.stateAt(cursor.stops[cursor.stops.length - 1]).state.user,
    };
    for (const [door, value] of Object.entries(served)) {
      const v = value as Record<string, unknown>;
      expect([door, recordKey(v, 'kind')]).toEqual([door, expected]);
      expect([door, Object.getPrototypeOf(v) === Object.prototype, v.isAdmin]).toEqual([door, true, undefined]);
    }
  });

  it('a shared sub-object reached through two keys: an edit through either served holder reaches nothing', async () => {
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        const meta = { at: new Date(5) };
        scope.$setValue('order', { created: { by: meta }, updated: { by: meta }, n: 1 });
      },
      'seed',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const served = executor.getSnapshot().commitLog[0].overwrite.order as any;
    served.created.by.at.setTime(0);
    served.updated.by.at.setTime(1);
    const again = executor.getSnapshot();
    const order = again.commitLog[0].overwrite.order as any;
    expect([order.created.by.at.getTime(), order.updated.by.at.getTime()]).toEqual([5, 5]);
    expect((stateAt(again, 0).state.order as any).updated.by.at.getTime()).toBe(5);
    expect((commitValueAt(again.commitLog, 0, 'order') as any).created.by.at.getTime()).toBe(5);
  });

  it('one value held by 150,000 containers: getSnapshot completes, and every later serve still copies', async () => {
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        const meta = { at: new Date(5) };
        scope.$setValue('rows', new Array(150_000).fill(meta));
      },
      'seed',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    // 39d7e270: RangeError here — and the serve after it handed out the log's own bundle
    const first = executor.getSnapshot();
    (first.commitLog[0].overwrite.rows as Array<{ at: Date }>)[0].at.setTime(0);
    const again = executor.getSnapshot();
    expect(again.commitLog[0] === first.commitLog[0]).toBe(false);
    expect((again.commitLog[0].overwrite.rows as Array<{ at: Date }>)[149_999].at.getTime()).toBe(5);
    expect((stateAt(again, 0).state.rows as Array<{ at: Date }>)[7].at.getTime()).toBe(5);
  });
});

describe('a reader’s answer is the caller’s own: editing it changes no later answer', () => {
  it('commitValueAt, stateAt and the cursor, on a snapshot of a run', async () => {
    const executor = await run();
    const snap = executor.getSnapshot();
    const log = snap.commitLog as CommitBundle[];
    const read = () =>
      recordKey(
        [
          commitValueAt(log, 0, 'rec'),
          stateAt(snap, 1).state,
          timeTravel(snap).stateAt().state,
          getSubtreeSnapshot(snap, 'sub')?.initialState,
        ],
        'kind',
      );
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
      const read = () => recordKey(executor.getSnapshot().sharedState.rec, 'kind');
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
