/**
 * The record is frozen at `EventLog · record` (F3, 9.33.0, ruling R3).
 *
 *   scenario  every bundle of a real run — the run's log, a subflow's `treeContext.history`, fork children,
 *             and the fields a bundle can carry (`tags`, `readKeys`, `redactedPaths`, `untrackedSources`) — is
 *             frozen in `getSnapshot().commitLog`, to every depth
 *   security  an assignment into a snapshot bundle throws, where until 9.32 one assignment forged every later
 *             `commitValueAt` and `stateAt` answer
 *   edge      a typed array in state commits and reads as before (the freeze skips it — the one state value
 *             that cannot be frozen); `getSnapshot()` with a `Uint8Array` in `initialContext` no longer
 *             throws (a regression the old walk carried); a Map in a bundle is served as a copy (9.44.2 —
 *             it was the named hole: freezing cannot reach its entries, and every snapshot shared them);
 *             a /g RegExp read from a bundle throws on `replace` (the named consequence)
 * Direct EventLog freezing is checked without the engine in frozen-record.test.ts.
 */
import { flowChart, FlowChartExecutor } from '../../../../src';
import type { CommitBundle } from '../../../../src/trace';
import { commitValueAt, stateAt } from '../../../../src/trace';
import { unfrozen } from '../../../helpers/unfrozen';

async function richRun() {
  const inner = flowChart(
    'Inner',
    (s: any) => {
      s.innerOut = { got: s.cfg?.a ?? null, list: [{ n: 1 }] };
    },
    'inner',
  ).build();
  const chart = flowChart(
    'Seed',
    (s: any) => {
      s.cfg = { a: 1, deep: { list: [{ x: [1, 2] }] } };
      s.secret = 'shh';
      s.echo = s.$getArgs<{ id: string }>().id; // an untracked source
    },
    'seed',
    { tags: ['milestone'] },
  )
    .addSubFlowChart('sub', inner, 'Sub', {
      inputMapper: (p: any) => ({ cfg: { a: p.cfg.a, b: 2 } }), // a nested seed
      outputMapper: (o: any) => ({ cfg: { fromSub: o.innerOut } }), // a nested merge-back
    })
    .addListOfFunction([
      {
        id: 'c0',
        name: 'C0',
        fn: (s: any) => {
          s.x = { y: [1] };
        },
      },
      {
        id: 'c1',
        name: 'C1',
        fn: (s: any) => {
          s.z = [{ w: 1 }];
        },
      },
    ])
    .addFunction(
      'Read',
      (s: any) => {
        s.out = { keys: Object.keys(s.cfg) };
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
  executor.setRedactionPolicy({ keys: ['secret'] });
  await executor.run({ input: { id: 'req-1' } });
  return executor.getSnapshot();
}

describe('the record is frozen at EventLog · record — scenario', () => {
  it('every bundle of the run and of its subflow is frozen to every depth, every field included', async () => {
    const snap = await richRun();
    const log = snap.commitLog as CommitBundle[];
    const sub = (snap.subflowResults as Record<string, { treeContext: { history: CommitBundle[] } }>).sub;
    const history = sub.treeContext.history;

    // the fields the run is built to carry are really there …
    expect(log.some((b) => b.tags !== undefined)).toBe(true);
    expect(log.some((b) => b.untrackedSources !== undefined)).toBe(true);
    expect(log.some((b) => b.redactedPaths.length > 0)).toBe(true);
    expect(log.some((b) => b.trace.some((t) => t.readKeys !== undefined))).toBe(true);
    expect(log.some((b) => b.runtimeStageId.startsWith('c0'))).toBe(true); // fork children committed here
    expect(history.length).toBeGreaterThan(0);

    // … and nothing in any bundle is left unfrozen.
    expect(unfrozen(log)).toEqual([]);
    expect(unfrozen(history)).toEqual([]);
  });

  it('an assignment into a snapshot bundle throws — it no longer forges commitValueAt or stateAt', async () => {
    const snap = await richRun();
    const log = snap.commitLog as CommitBundle[];
    const seed = log.find((b) => b.stageId === 'seed' && b.trace.some((t) => t.path === 'cfg'))!;
    const before = [
      JSON.stringify(commitValueAt(log, seed.idx!, 'cfg')),
      JSON.stringify(stateAt(snap, seed.idx!).state.cfg),
    ];

    expect(() => {
      (seed.overwrite.cfg as { a: number }).a = 999;
    }).toThrow(TypeError);
    expect(() => {
      (seed.trace as unknown[]).push({ path: 'forged', verb: 'set' });
    }).toThrow(TypeError);
    expect(() => {
      (seed.trace[0] as { verb: string }).verb = 'delete';
    }).toThrow(TypeError);
    expect(() => {
      delete (seed.overwrite as Record<string, unknown>).cfg;
    }).toThrow(TypeError);

    expect([
      JSON.stringify(commitValueAt(log, seed.idx!, 'cfg')),
      JSON.stringify(stateAt(snap, seed.idx!).state.cfg),
    ]).toEqual(before);
  });

  it('the live state is NOT frozen: a later stage still writes the keys the log froze copies of', async () => {
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { list: [1] };
      },
      'a',
    )
      .addFunction(
        'B',
        (s: any) => {
          s.cfg.list.push(2);
        },
        'b',
      )
      .addFunction(
        'C',
        (s: any) => {
          s.$update('cfg', { more: true });
        },
        'c',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.cfg).toEqual({ list: [1, 2], more: true });
  });
});

describe('the record is frozen — edges and named holes', () => {
  it('a typed array in state commits, reads back, and is the one value left unfrozen in the log', async () => {
    const chart = flowChart('S', (s: any) => s.$setValue('buf', new Uint8Array([1, 2, 3])), 's')
      .addFunction(
        'R',
        (s: any) => {
          s.n = (s.$getValue('buf') as Uint8Array).length;
        },
        'r',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snap = executor.getSnapshot();
    expect(snap.sharedState.n).toBe(3);
    const buf = snap.commitLog[0].overwrite.buf as Uint8Array;
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(Object.isFrozen(snap.commitLog[0].overwrite)).toBe(true);
    expect(Object.isFrozen(buf)).toBe(false); // a non-empty typed array cannot be frozen
  });

  it('regression: getSnapshot() with a Uint8Array in initialContext no longer throws', async () => {
    const executor = new FlowChartExecutor(
      flowChart(
        'S',
        (s: any) => {
          s.k = 1;
        },
        's',
      ).build(),
      {
        initialContext: { buf: new Uint8Array([9]) },
      },
    );
    await executor.run();
    expect(() => executor.getSnapshot()).not.toThrow();
    expect((executor.getSnapshot().initialState as { buf: Uint8Array }).buf[0]).toBe(9);
  });

  it('a Map inside a bundle is served as a copy: an edit reaches no later snapshot (the hole, closed in 9.44.2)', async () => {
    const executor = new FlowChartExecutor(
      flowChart('S', (s: any) => s.$setValue('m', new Map([['k', 1]])), 's').build(),
    );
    await executor.run();
    const map = executor.getSnapshot().commitLog[0].overwrite.m as Map<string, number>;
    expect(Object.isFrozen(map)).toBe(true);
    map.set('forged', 2); // Object.freeze cannot reach a Map's entries — but this Map is the holder's copy
    expect(map.get('forged')).toBe(2);
    const later = executor.getSnapshot();
    expect((later.commitLog[0].overwrite.m as Map<string, number>).has('forged')).toBe(false);
    expect((stateAt(later, 0).state.m as Map<string, number>).has('forged')).toBe(false);
  });

  it('a /g RegExp read from a bundle throws when replace advances it — copy it to use it', async () => {
    const executor = new FlowChartExecutor(flowChart('S', (s: any) => s.$setValue('re', /a/g), 's').build());
    await executor.run();
    const re = executor.getSnapshot().commitLog[0].overwrite.re as RegExp;
    expect(() => 'aa'.replace(re, 'b')).toThrow(TypeError);
    expect('aa'.replace(new RegExp(re), 'b')).toBe('bb');
  });
});
