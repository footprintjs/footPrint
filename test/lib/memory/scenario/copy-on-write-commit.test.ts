/**
 * Copy-on-write commit (9.29.0) — the law it keeps and every behaviour it
 * moves, pinned by name (docs/design/2026-10-copy-on-write-commit.md).
 *
 * Each named case runs on BOTH engines: the published 9.28.0
 * (`footprintjs-baseline`) and this tree's `src`, so the "before" in every
 * assertion is the real old behaviour, not a description of it.
 *
 *   THE LAW — a committed generation is never edited: every generation a
 *     stage saw is unchanged at the end of the run (fast-check, through the
 *     typed scope and through `StageContext` at nested and namespaced
 *     paths), and two forks whose children `$update` their namespaces leave
 *     the generation between them untouched.
 *   A read the working copy cannot answer (the stage deleted or unset the
 *     path) is served from live state, as on 9.28.0, and the diff base is
 *     kept exact: an in-place edit written back is recorded, as on 9.28.0.
 *   D1 (fix) — an inputMapper that passes a parent object through froze the
 *     parent's committed object (TypeError on a later nested write).
 *   D2 (fix) — the redacted mirror shared containers with the commit log.
 *   M1, M1b, M2 + a merge variant — a read mutated in place after the
 *     stage's first write: exactly as 9.28.0 (option D, private reads),
 *     dev-mode warning included.
 *   M3 — value semantics: a write through one of two aliased positions
 *     changes that path only.
 *   M4 — a class instance in `initialContext` is a plain object from the
 *     first stage.
 *   M5 (fix) — the caller's `initialContext` objects are detached at
 *     construction.
 *   M6 (fix) — expandos a nested engine write hangs on a committed `Date`
 *     stay in live state, as in the record — so a later identical merge-back
 *     records no row.
 *   M7 — a value read BEFORE the stage's first write, mutated in place AFTER
 *     it and written back: no longer recorded (9.28.0 recorded it by
 *     accident); dev mode now says so.
 *   M8 — a write THROUGH a value the same stage set no longer edits that
 *     value in place: its retained `stageWrites` entry is the value as written.
 *   Private reads never copy a value the stage staged — even the committed
 *     object itself, written back: the read hands it back, as on 9.28.0.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type Engine,
  type NestedProgram,
  BASELINE,
  BUILD,
  bytes,
  containersOf,
  firstDifference,
  nestedProgramArb,
  runNested,
} from '../property/copy-on-write-fixture.js';

const ENGINES = [BASELINE, BUILD] as const;

type Run = {
  state: any;
  fold: any;
  rows: string[];
  warnings: string[];
  error: string;
  snap: any;
  ex: any;
};

/** Run the chart `make` builds on `engine`; rows read `stageId: path:verb …`. */
async function run(engine: Engine, make: (e: Engine) => any, options: any = {}, dev = false): Promise<Run> {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(String(a[0]));
  };
  if (dev) engine.enableDevMode();
  const ex = new engine.FlowChartExecutor(make(engine), options);
  let error = '';
  try {
    await ex.run();
  } catch (e) {
    error = `${(e as Error).name}: ${(e as Error).message}`;
  } finally {
    if (dev) engine.disableDevMode();
    console.warn = realWarn;
  }
  const snap = ex.getSnapshot();
  const last = snap.commitLog.length - 1;
  return {
    ex,
    snap,
    state: snap.sharedState,
    fold: last >= 0 ? engine.stateAt(snap, last).state : {},
    rows: snap.commitLog.map(
      (b: any) => `${b.stageId}: ${b.trace.map((t: any) => `${t.path.split('\u001f').join('.')}:${t.verb}`).join(' ')}`,
    ),
    warnings,
    error,
  };
}

/** Linear chart of stage functions s0, s1, … */
const linear =
  (...fns: Array<(s: any) => void>) =>
  (e: Engine) => {
    let b = e.flowChart('S0', fns[0], 's0');
    fns.slice(1).forEach((fn, i) => {
      b = b.addFunction(`S${i + 1}`, fn, `s${i + 1}`);
    });
    return b.build();
  };

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('THE LAW — a committed generation is never edited', () => {
  type Op = { t: 'set' | 'setIn' | 'push' | 'elem' | 'update' | 'del'; k: string; v: number };
  const op = fc.record({
    t: fc.constantFrom('set', 'setIn', 'push', 'elem', 'update', 'del') as fc.Arbitrary<Op['t']>,
    k: fc.constantFrom('a', 'b', 'list', 'obj'),
    v: fc.integer({ min: 0, max: 9 }),
  });
  const apply = (s: any, o: Op) => {
    const cur = s.$getValue(o.k);
    const isObj = cur !== null && typeof cur === 'object' && !Array.isArray(cur);
    if (o.t === 'set') s[o.k] = { n: o.v, deep: { v: o.v }, arr: [{ v: o.v }] };
    else if (o.t === 'setIn') isObj ? (s[o.k].deep = { v: o.v }) : (s[o.k] = { deep: { v: o.v } });
    else if (o.t === 'push') Array.isArray(cur) ? s[o.k].push({ v: o.v }) : (s[o.k] = [{ v: o.v }]);
    else if (o.t === 'elem') Array.isArray(cur) && cur[0] && typeof cur[0] === 'object' && (s[o.k][0].v = o.v);
    else if (o.t === 'update') s.$update(o.k, { extra: o.v });
    else delete s[o.k];
  };

  it('every generation a stage saw still equals, at the end of the run, the copy taken when it was seen', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(op, { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        fc.constantFrom('full', 'delta'),
        fc.boolean(),
        async (stages, commitValues, mirror) => {
          const seen: Array<{ ref: unknown; copy: string }> = [];
          const holder: { ex?: any } = {};
          const capture = () => {
            const snap = holder.ex?.getSnapshot();
            if (snap) seen.push({ ref: snap.sharedState, copy: bytes(snap.sharedState) });
            const red = mirror ? holder.ex?.getSnapshot({ redact: true }) : undefined;
            if (red) seen.push({ ref: red.sharedState, copy: bytes(red.sharedState) });
          };
          const stageOf = (ops: Op[]) => (s: any) => {
            capture();
            ops.forEach((o) => apply(s, o));
          };
          let b = BUILD.flowChart('S0', stageOf(stages[0]), 's0');
          stages.slice(1).forEach((ops, i) => {
            b = b.addFunction(`S${i + 1}`, stageOf(ops), `s${i + 1}`);
          });
          b = b.addFunction('End', () => capture(), 'end');
          holder.ex = new BUILD.FlowChartExecutor(b.build(), { commitValues });
          if (mirror) holder.ex.setRedactionPolicy({ keys: ['b'] });
          await holder.ex.run();
          for (const { ref, copy } of seen) expect(bytes(ref)).toBe(copy);
        },
      ),
      { numRuns: 150, seed: 20261004 },
    );
  });

  it('StageContext at nested and namespaced paths (in contract): no generation is edited by a later commit', () => {
    // The typed scope writes root keys; this is the nested-row family (/zod,
    // the subflow doors, fork children), where a replay that skipped its path
    // copy would edit the generation it builds on with no byte to show it.
    fc.assert(
      fc.property(nestedProgramArb, (p0) => {
        const p: NestedProgram = { ...p0, mutate: false };
        const laws = { editedGenerations: 0 };
        runNested(BUILD, p, laws);
        expect(laws.editedGenerations).toBe(0);
      }),
      { numRuns: 3000, seed: 5150 },
    );
  });

  it('two forks whose children $update their namespace: the generation between them is never edited', async () => {
    const seen: Array<{ ref: unknown; copy: string }> = [];
    const holder: { ex?: any } = {};
    const capture = () => {
      const ref = holder.ex?.getSnapshot().sharedState;
      if (ref) seen.push({ ref, copy: bytes(ref) });
    };
    const kids = (tag: string) => [
      {
        id: `a${tag}`,
        name: `A${tag}`,
        fn: (s: any) => {
          s.$update('k', { [tag]: 1 });
          s.$update('k', { deep: { [tag]: [1] } });
        },
      },
      {
        id: `b${tag}`,
        name: `B${tag}`,
        fn: (s: any) => {
          s.$update('k', { [tag]: 2 });
        },
      },
    ];
    const chart = BUILD.flowChart(
      'Seed',
      (s: any) => {
        capture();
        s.x = 1;
      },
      'seed',
    )
      .addListOfFunction(kids('1'))
      .addFunction(
        'Mid',
        (s: any) => {
          capture(); // the generation the second fork's children build on
          s.y = 1;
        },
        'mid',
      )
      .addListOfFunction(kids('2'))
      .addFunction('End', () => capture(), 'end')
      .build();
    for (const commitValues of ['full', 'delta'] as const) {
      seen.length = 0;
      holder.ex = new BUILD.FlowChartExecutor(chart, { commitValues });
      await holder.ex.run();
      expect(seen.length).toBe(3);
      for (const { ref, copy } of seen) expect(bytes(ref)).toBe(copy);
    }
  });
});

describe('A read the working copy cannot answer — served from live state, the diff base kept exact (as on 9.28.0)', () => {
  // After the stage's first write, a read of a path the stage deleted or
  // unset (or replaced a container above) falls through the buffer to LIVE
  // committed state — on both engines. 9.28.0's diff base was a clone taken at
  // the first write, so an in-place edit of that value (out of contract)
  // written back was recorded; the build's base is the committed generation
  // itself, so it is detached at that path first (TransactionBuffer ·
  // detachBase) — not the value handed out, which stays the live one.
  const writeBack = (variant: 'delete' | 'unset') =>
    linear(
      (s) => {
        s.cfg = { n: 1 };
        s.other = 0;
      },
      (s) => {
        if (variant === 'delete') delete s.cfg; // the first write
        else {
          s.other = 1; // the first write
          s.cfg = undefined;
        }
        const c = s.$getValue('cfg'); // the buffer holds undefined: served from live state
        c.n = 99; // in place — out of contract
        s.$setValue('cfg', c);
      },
      (s) => {
        s.seen = s.$getValue('cfg').n;
      },
    );

  for (const variant of ['delete', 'unset'] as const)
    for (const commitValues of ['full', 'delta'] as const) {
      it(`${variant}, read back, edit in place, write back (${commitValues}): recorded, exactly as on 9.28.0`, async () => {
        const before = await run(BASELINE, writeBack(variant), { commitValues }, true);
        const after = await run(BUILD, writeBack(variant), { commitValues }, true);
        expect(after.rows).toEqual(before.rows);
        expect(bytes(after.snap.commitLog)).toBe(bytes(before.snap.commitLog));
        expect(bytes(after.state)).toBe(bytes(before.state));
        expect(after.warnings).toEqual(before.warnings);
        expect(after.rows[1]).toContain('cfg:');
        expect(plain(after.fold).cfg).toEqual({ n: 99 });
        expect(plain(after.state).cfg).toEqual({ n: 99 });
        expect(plain(after.state).seen).toBe(99);
      });
    }

  // The two shapes the differential's NESTED family found (StageContext).
  const pinned: Array<[string, NestedProgram]> = [
    [
      'seed 102938, program 1,976: a merge replaced the container, the read below it fell through, the edit moved the base',
      {
        initial: { list: { list: [] } },
        stages: [
          {
            runId: '',
            ops: [
              { t: 'merge', path: 0, k: 'list', v: 0 },
              { t: 'merge', path: 3, k: 'x', v: 's' },
              { t: 'mutRead', path: 3, k: 'list', v: 0 },
            ],
          },
          { runId: '', ops: [] },
        ],
        commitValues: 'delta',
        mutate: true,
      },
    ],
    [
      'a run-namespaced read that falls back to a global key: the edit reaches live state, as on 9.28.0 (why the value is not privatised)',
      {
        initial: { x: {} },
        stages: [
          {
            runId: 'r2',
            ops: [
              { t: 'merge', path: 0, k: '0', v: 0 },
              { t: 'mutRead', path: 0, k: 'x', v: 0 },
            ],
          },
          { runId: '', ops: [] },
        ],
        commitValues: 'full',
        mutate: true,
      },
    ],
  ];
  for (const [name, program] of pinned)
    for (const commitValues of ['full', 'delta'] as const) {
      it(`${name} (${commitValues})`, () => {
        const p = { ...program, commitValues };
        expect(firstDifference(runNested(BASELINE, p), runNested(BUILD, p))).toBe('');
      });
    }
});

describe('D1 (fix) — an inputMapper that passes a parent object through does not freeze the parent’s state', () => {
  const mount = (e: Engine) => {
    const inner = e
      .flowChart(
        'Inner',
        (s: any) => {
          s.seenX = s.$getArgs().cfg.x; // the subflow reads its (frozen) args
        },
        'inner',
      )
      .build();
    return e
      .flowChart(
        'S0',
        (s: any) => {
          s.cfg = { x: 0 };
        },
        's0',
      )
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: (parent: any) => ({ cfg: parent.cfg }) })
      .addFunction(
        'S1',
        (s: any) => {
          s.cfg.x = 1; // a nested write through the scope proxy, after a mount that committed nothing
        },
        's1',
      )
      .build();
  };

  it('9.28.0 reproduces the bug: the parent’s later nested write meets the frozen object (TypeError)', async () => {
    const before = await run(BASELINE, mount);
    expect(before.error).toMatch(/TypeError: Cannot assign to read only property 'x'/);
    expect(before.rows.some((r) => r.startsWith('s1: cfg'))).toBe(false);
  });

  it('the build: the write lands and is recorded', async () => {
    const after = await run(BUILD, mount);
    expect(after.error).toBe('');
    expect(plain(after.state).cfg).toEqual({ x: 1 });
    expect(after.rows).toContain('s1: cfg:merge'); // a nested object write commits as a merge of its root key
    expect(plain(after.fold).cfg).toEqual({ x: 1 });
  });

  it('the subflow’s args are still frozen — the guarantee stays, on a detached copy', async () => {
    let threw = '';
    const make = (e: Engine) => {
      const inner = e
        .flowChart(
          'Inner',
          (s: any) => {
            try {
              s.$getArgs().cfg.x = 99;
            } catch (err) {
              threw = (err as Error).name;
            }
          },
          'inner',
        )
        .build();
      return e
        .flowChart(
          'S0',
          (s: any) => {
            s.cfg = { x: 0 };
          },
          's0',
        )
        .addSubFlowChart('sub', inner, 'Sub', { inputMapper: (parent: any) => ({ cfg: parent.cfg }) })
        .build();
    };
    const after = await run(BUILD, make);
    expect(threw).toBe('TypeError');
    expect(plain(after.state).cfg).toEqual({ x: 0 });
    expect(Object.isFrozen((after.state as any).cfg)).toBe(false); // the parent's committed object
  });
});

describe('D2 (fix) — served state never shares a container with the commit log', () => {
  const make = linear(
    (s) => {
      s.list = [{ n: 0 }];
    },
    (s) => s.$update('list', [{ n: 1 }]),
  );

  /** Labels of the served views that reach a container of the log. */
  const sharing = (r: Run) => {
    const log = new Set<object>();
    for (const b of r.snap.commitLog) {
      containersOf(b.overwrite, log);
      containersOf(b.updates, log);
    }
    const hits: string[] = [];
    const views: Array<[string, unknown]> = [
      ['sharedState', r.ex.getSnapshot().sharedState],
      ['redactedState', r.ex.getSnapshot({ redact: true }).sharedState],
    ];
    for (const [label, view] of views) {
      if ([...containersOf(view)].some((c) => log.has(c))) hits.push(label);
    }
    return hits;
  };

  it.each(['full', 'delta'] as const)(
    '9.28.0 served a mirror that shared the log’s merge elements; the build does not (%s)',
    async (cv) => {
      const runOn = async (e: Engine) => {
        const ex = new e.FlowChartExecutor(make(e), { commitValues: cv });
        ex.setRedactionPolicy({ keys: ['unrelatedSecret'] });
        await ex.run();
        return { ex, snap: ex.getSnapshot() } as Run;
      };
      expect(sharing(await runOn(BASELINE))).toContain('redactedState');
      expect(sharing(await runOn(BUILD))).toEqual([]);
    },
  );
});

describe('M1, M1b, M2 — a read mutated in place: the behaviour 9.28.0 had, warnings included (option D)', () => {
  // One engine at a time: each run swaps `console.warn` to collect its warnings.
  const same = async (make: (e: Engine) => any) => {
    const before = await run(BASELINE, make, {}, true);
    const after = await run(BUILD, make, {}, true);
    expect(after.rows).toEqual(before.rows);
    expect(plain(after.state)).toEqual(plain(before.state));
    expect(plain(after.fold)).toEqual(plain(before.fold));
    return { before, after };
  };

  it('M1 — read AFTER the first write, mutated, written back as the same object: recorded, as before', async () => {
    const { after } = await same(
      linear(
        (s) => {
          s.cfg = { x: 1 };
        },
        (s) => {
          s.other = 1; // the stage's first write
          const c = s.$getValue('cfg'); // the stage's own copy (private read)
          c.x = 99;
          s.$setValue('cfg', c);
        },
      ),
    );
    expect(after.rows).toEqual(['s0: cfg:set', 's1: other:set cfg:set']);
    expect(plain(after.state).cfg).toEqual({ x: 99 });
    expect(plain(after.fold).cfg).toEqual({ x: 99 });
    expect(after.warnings).toEqual([]);
  });

  it('M1b — read, mutated and written back BEFORE any other write: dropped, as before — and dev mode now says so', async () => {
    const { before, after } = await same(
      linear(
        (s) => {
          s.cfg = { x: 1 };
        },
        (s) => {
          const c = s.$getValue('cfg'); // committed state itself
          c.x = 99;
          s.$setValue('cfg', c);
        },
      ),
    );
    expect(after.rows).toEqual(['s0: cfg:set', 's1: ']);
    expect(plain(after.state).cfg).toEqual({ x: 99 }); // live keeps the edit…
    expect(plain(after.fold).cfg).toEqual({ x: 1 }); // …the record does not — in both
    expect(before.warnings).toEqual([]);
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toContain(
      'changed `cfg.x` IN PLACE on the committed value it read before its first write',
    );
  });

  it('M2 — an element mutated in place after the first write, never written back: lost, state untouched, warned', async () => {
    const { before, after } = await same(
      linear(
        (s) => {
          s.hist = [{ n: 1 }, { n: 2 }];
        },
        (s) => {
          s.other = 1;
          for (const e of s.hist) if (e.n === 1) e.n = 5; // for…of hands out raw elements
        },
      ),
    );
    expect(plain(after.state).hist).toEqual([{ n: 1 }, { n: 2 }]);
    expect(after.warnings).toEqual(before.warnings);
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toContain('changed `hist[0].n` IN PLACE');
  });

  it('M2 after a merge of the same key — the merged value’s elements are the stage’s own too', async () => {
    const { before, after } = await same(
      linear(
        (s) => {
          s.hist = [{ n: 1 }];
        },
        (s) => {
          s.$update('hist', [{ n: 9 }]); // the first write: a merge into the committed array
          for (const e of s.hist) e.n = 5; // raw elements, edited in place
        },
        (s) => {
          s.seen = s.hist.map((e: any) => e.n);
        },
      ),
    );
    // The committed element's edit stayed inside the stage (its private copy);
    // the merged-in element is the stage's OWN object, shared with the staged
    // delta, so its edit is recorded — exactly as on 9.28.0.
    expect(plain(after.state).seen).toEqual([1, 5]);
    expect(after.warnings).toEqual(before.warnings);
  });
});

describe('M3 — value semantics: a write changes exactly its own path', () => {
  it('aliased initial state: a nested write through `a` no longer changes `b`', async () => {
    const make = (e: Engine) => {
      const inner = e
        .flowChart(
          'In',
          (s: any) => {
            s.done = true;
          },
          'in',
        )
        .build();
      return e
        .flowChart(
          'S0',
          (s: any) => {
            s.seenV = s.a.v;
          },
          's0',
        )
        .addSubFlowChart('sub', inner, 'Sub', { outputMapper: () => ({ a: { x: 1 } }) }) // a nested row: a.x
        .build();
    };
    const shared = () => {
      const o = { v: 0 };
      return { initialContext: { a: o, b: o } };
    };
    const before = await run(BASELINE, make, shared());
    const after = await run(BUILD, make, shared());
    expect(plain(before.state)).toMatchObject({ a: { v: 0, x: 1 }, b: { v: 0, x: 1 } });
    expect(plain(after.state)).toMatchObject({ a: { v: 0, x: 1 }, b: { v: 0 } });
    expect(plain(after.state).b.x).toBeUndefined();
    expect(plain(after.fold)).toMatchObject({ a: { v: 0, x: 1 }, b: { v: 0 } }); // the fold follows the same law
  });
});

describe('M4 — a class instance in initialContext is a plain object from the first stage', () => {
  it('9.28.0 handed the first stages the caller’s instance until the first commit; the build never does', async () => {
    class Cfg {
      n = 2;
      double() {
        return this.n * 2;
      }
    }
    const make = linear((s) => {
      s.out = s.$getValue('cfg').double?.() ?? 'no method';
    });
    const before = await run(BASELINE, make, { initialContext: { cfg: new Cfg() } });
    const after = await run(BUILD, make, { initialContext: { cfg: new Cfg() } });
    expect(plain(before.state).out).toBe(4);
    expect(plain(after.state).out).toBe('no method');
    expect(plain(after.state).cfg).toEqual({ n: 2 });
  });
});

describe('M5 (fix) — the caller’s initialContext is detached at construction', () => {
  it('a caller mutating its seed object during the first stage no longer changes live state behind the record', async () => {
    const go = async (e: Engine) => {
      const seed = { cfg: { n: 1 } };
      return run(
        e,
        linear((s) => {
          seed.cfg.n = 42; // the caller's own object, mid-run
          s.seen = s.cfg.n;
        }),
        { initialContext: seed },
      );
    };
    const before = await go(BASELINE);
    const after = await go(BUILD);
    expect(plain(before.state).cfg.n).toBe(42); // live moved with no row…
    expect(plain(before.fold).cfg.n).toBe(1); // …the fold did not
    expect(plain(after.state)).toEqual({ cfg: { n: 1 }, seen: 1 });
    expect(plain(after.fold)).toEqual({ cfg: { n: 1 }, seen: 1 });
  });
});

describe('M6 (fix) — expandos a nested engine write hangs on a committed Date stay in live state', () => {
  const make = (e: Engine) => {
    const inner = (id: string) =>
      e
        .flowChart(
          'In',
          (s: any) => {
            s.done = true;
          },
          id,
        )
        .build();
    return e
      .flowChart(
        'S0',
        (s: any) => {
          s.$setValue('when', new Date(0));
        },
        's0',
      )
      .addSubFlowChart('sub1', inner('in1'), 'Sub1', { outputMapper: () => ({ when: { y: 1 } }) })
      .addSubFlowChart('sub2', inner('in2'), 'Sub2', { outputMapper: () => ({ when: { z: 2 } }) })
      .addFunction(
        'S1',
        (s: any) => {
          s.other = 1; // any later commit
        },
        's1',
      )
      .build();
  };

  it('9.28.0 dropped them at the next commit while the record kept them; the build keeps both, as the record does', async () => {
    const before = await run(BASELINE, make);
    const after = await run(BUILD, make);
    for (const r of [before, after]) {
      expect(r.rows.some((row) => row.includes('when.y:set'))).toBe(true);
      expect(r.rows.some((row) => row.includes('when.z:set'))).toBe(true);
      expect(r.state.when).toBeInstanceOf(Date);
    }
    expect(before.state.when.y).toBeUndefined();
    expect(before.state.when.z).toBeUndefined();
    expect(after.state.when.y).toBe(1); // a later write through the Date changed only its own path
    expect(after.state.when.z).toBe(2);
    expect(after.state.when.getTime()).toBe(0);
  });

  it('so a LATER identical merge-back records no row: the expando is already in live state (9.28.0 re-recorded it)', async () => {
    // A loop: each iteration's subflow merges { x: 1 } into `b`, then P sets
    // `b` to a Date of the same instant (no change after the first time).
    const loop = (e: Engine) => {
      const inner = e.flowChart('Inner', () => undefined, 'inner').build();
      return e
        .flowChart(
          'Head',
          (s: any) => {
            s.iter = (s.iter ?? 0) + 1;
          },
          'head',
        )
        .addSubFlowChartNext('sub', inner, 'Sub', {
          inputMapper: () => ({ obj: { x: 1 } }),
          outputMapper: (o: any) => ({ b: o.obj }),
        })
        .addFunction(
          'P',
          (s: any) => {
            s.b = new Date(1_700_000_000_000);
          },
          'p',
        )
        .addDeciderFunction('Route', (s: any) => (s.iter < 3 ? 'again' : 'final'), 'route')
        .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
        .addFunctionBranch('final', 'Final', () => undefined, 'final')
        .end()
        .build();
    };
    const mergeBacks = (r: Run) =>
      r.snap.commitLog
        .filter((b: any) => b.stage === 'Sub')
        .map((b: any) => b.trace.map((t: any) => t.path.split('\u001f').join('.')).join(' '))
        .filter((rows: string) => rows !== '');
    const before = await run(BASELINE, loop);
    const after = await run(BUILD, loop);
    expect(mergeBacks(before)).toEqual(['b.x', 'b.x', 'b.x']); // iteration 3: the clone had dropped it, so it changed again
    expect(mergeBacks(after)).toEqual(['b.x', 'b.x']); // iteration 3: already there — no change, no row
    expect(after.state.b.x).toBe(1);
    expect(before.state.b.x).toBeUndefined();
  });
});

describe('M7 — read BEFORE the first write, mutated in place AFTER it, written back', () => {
  const make = linear(
    (s) => {
      s.cfg = { x: 1 };
    },
    (s) => {
      const c = s.$getValue('cfg'); // before the stage's first write: committed state itself
      s.other = 1; // the first write
      c.x = 99; // in place — out of contract
      s.$setValue('cfg', c);
    },
  );

  it('9.28.0 recorded it by accident; the build records no change — and dev mode says why', async () => {
    const before = await run(BASELINE, make, {}, true);
    const after = await run(BUILD, make, {}, true);
    expect(before.rows).toEqual(['s0: cfg:set', 's1: other:set cfg:set']);
    expect(plain(before.fold).cfg).toEqual({ x: 99 });
    expect(before.warnings).toEqual([]);

    expect(after.rows).toEqual(['s0: cfg:set', 's1: other:set']);
    expect(plain(after.state).cfg).toEqual({ x: 99 }); // live keeps the edit…
    expect(plain(after.fold).cfg).toEqual({ x: 1 }); // …the record does not
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toContain('[footprint] Stage "S1" changed `cfg.x` IN PLACE on the committed value');
  });

  it('the honest form — build the next value — records the change on both engines', async () => {
    const honest = linear(
      (s) => {
        s.cfg = { x: 1 };
      },
      (s) => {
        const c = s.$getValue('cfg');
        s.other = 1;
        s.$setValue('cfg', { ...c, x: 99 });
      },
    );
    for (const e of ENGINES) {
      const r = await run(e, honest, {}, true);
      expect(r.rows).toEqual(['s0: cfg:set', 's1: other:set cfg:set']);
      expect(plain(r.fold).cfg).toEqual({ x: 99 });
      expect(r.warnings).toEqual([]);
    }
  });
});

describe('M8 — a write THROUGH a value the same stage set no longer edits that value', () => {
  it('the caller’s object stays as written; log and state are byte-identical', () => {
    const out = ENGINES.map((e) => {
      const mem = new e.SharedMemory();
      const log = new e.EventLog(mem.getState());
      const ctx = new e.StageContext('', 'S0', 's0', mem, '', log);
      const deep = { a: 1 };
      ctx.setObject(['obj'], 'deep', deep);
      ctx.setObject(['obj', 'deep'], 'x', 2); // a nested write through the value just set (/zod, StageContext)
      ctx.commit();
      return { deep, stageWrites: ctx.getSnapshot().stageWrites, log: bytes(log.list()), state: bytes(mem.getState()) };
    });
    const [before, after] = out;
    expect(after.log).toBe(before.log);
    expect(after.state).toBe(before.state);
    expect(before.deep).toEqual({ a: 1, x: 2 }); // 9.28.0 edited the caller's object in place…
    expect(before.stageWrites['obj.deep']).toEqual({ a: 1, x: 2 });
    expect(after.deep).toEqual({ a: 1 }); // …the build copies it first
    expect(after.stageWrites['obj.deep']).toEqual({ a: 1 });
    expect(after.stageWrites['obj.deep.x']).toBe(2);
  });
});

describe('Private reads never copy a value the stage staged — even the committed object itself, written back', () => {
  // `TransactionBuffer · privatise` hands a STAGED container back by
  // reference. A write-back of the committed object itself makes the staged
  // value and the diff base's value one object; were the read to privatise
  // it, the working copy and overwritePatch would disagree about a value the
  // stage wrote (the prototype recorded a phantom set of the OLD value).
  it('the read returns the very object written back, as on 9.28.0; the record is unchanged', async () => {
    const identities: boolean[] = [];
    const make = linear(
      (s) => {
        s.cfg = { n: 1 };
      },
      (s) => {
        const c = s.$getValue('cfg'); // before the first write: committed state itself
        s.$setValue('cfg', c); // the first write: the committed object, written back
        identities.push(s.$getValue('cfg') === c);
      },
    );
    for (const commitValues of ['full', 'delta'] as const) {
      identities.length = 0;
      const before = await run(BASELINE, make, { commitValues });
      const after = await run(BUILD, make, { commitValues });
      expect(identities).toEqual([true, true]);
      expect(bytes(after.snap.commitLog)).toBe(bytes(before.snap.commitLog));
      expect(after.rows).toEqual(['s0: cfg:set', 's1: ']);
    }
  });
});
