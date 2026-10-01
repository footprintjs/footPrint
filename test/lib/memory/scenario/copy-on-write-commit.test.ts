/**
 * Copy-on-write commit (design 2026-10) — the laws it keeps and the
 * behaviours it moves, pinned by name.
 *
 *   1. Immutable-after-swap, the strong form: no commit edits ANY earlier
 *      generation — each generation a stage saw still equals, at the end of
 *      the run, the copy taken when it was seen (property, fast-check).
 *   2. D1 — a subflow's args are frozen in place (`createFrozenArgs`); an
 *      inputMapper that passes a parent object through used to freeze the
 *      parent's COMMITTED object, so a later `scope.cfg.x = 1` in the parent
 *      met a raw frozen value (the typed scope does not proxy frozen values).
 *      Stock hid it only until the parent's next non-empty commit re-cloned
 *      the state; under copy-on-write nothing re-clones, so the mapped input
 *      is detached once per mount.
 *   3. D2 — no container of the commit log is reachable from served state
 *      (live heap, redacted mirror): the replay detaches merge deltas.
 *   4. M3 — value semantics: a write through one of two aliased positions
 *      changes that path only.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';

describe('copy-on-write commit — immutable-after-swap, strong form', () => {
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

  it('every generation a stage saw is unchanged at the end of the run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(op, { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        fc.constantFrom('full', 'delta'),
        async (stages, commitValues) => {
          const seen: Array<{ ref: unknown; copy: unknown }> = [];
          const holder: { executor?: FlowChartExecutor } = {};
          const capture = () => {
            const ref = holder.executor?.getSnapshot().sharedState;
            seen.push({ ref, copy: structuredClone(ref) });
          };
          const stageOf = (ops: Op[]) => (s: any) => {
            capture();
            ops.forEach((o) => apply(s, o));
          };
          let builder = flowChart<any>('S0', stageOf(stages[0]), 's0');
          stages.slice(1).forEach((ops, i) => {
            builder = builder.addFunction(`S${i + 1}`, stageOf(ops), `s${i + 1}`);
          });
          builder = builder.addFunction('End', () => capture(), 'end');
          holder.executor = new FlowChartExecutor(builder.build(), { commitValues });
          await holder.executor.run();
          for (const { ref, copy } of seen) expect(ref).toEqual(copy);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('D1 — an inputMapper that passes a parent object through does not freeze the parent’s state', () => {
  it('a later nested write in the parent is recorded (no outputMapper — the mount commits nothing)', async () => {
    const inner = flowChart<any>(
      'Inner',
      (s) => {
        s.seenX = s.$getArgs().cfg.x; // the subflow reads its (frozen) args
      },
      'inner',
    ).build();
    const chart = flowChart<any>(
      'S0',
      (s) => {
        s.cfg = { x: 0 };
      },
      's0',
    )
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: (parent: any) => ({ cfg: parent.cfg }) })
      .addFunction(
        'S1',
        (s) => {
          s.cfg.x = 1; // the stage's first op: a nested write through the scope proxy
        },
        's1',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect((snapshot.sharedState as any).cfg).toEqual({ x: 1 });
    expect(snapshot.commitLog.some((b) => b.stageId === 's1' && b.trace.length > 0)).toBe(true);
  });

  it('the subflow’s args are still frozen — the guarantee stays, on a detached copy', async () => {
    let threw = '';
    const inner = flowChart<any>(
      'Inner',
      (s) => {
        try {
          s.$getArgs().cfg.x = 99;
        } catch (e) {
          threw = (e as Error).name;
        }
      },
      'inner',
    ).build();
    const chart = flowChart<any>(
      'S0',
      (s) => {
        s.cfg = { x: 0 };
      },
      's0',
    )
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: (parent: any) => ({ cfg: parent.cfg }) })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(threw).toBe('TypeError');
    expect((executor.getSnapshot().sharedState as any).cfg).toEqual({ x: 0 });
  });
});

describe('D2 — served state never shares a container with the commit log', () => {
  /** Every container reachable from `v`. */
  const containers = (v: unknown, into = new Set<object>()): Set<object> => {
    const stack = [v];
    while (stack.length) {
      const x = stack.pop();
      if (x === null || typeof x !== 'object' || into.has(x)) continue;
      into.add(x);
      for (const k of Object.keys(x)) stack.push((x as Record<string, unknown>)[k]);
    }
    return into;
  };

  it.each(['full', 'delta'] as const)(
    'merge deltas replayed into the live heap and the redacted mirror are copies (%s)',
    async (cv) => {
      const chart = flowChart<any>(
        'S0',
        (s) => {
          s.list = [{ n: 0 }];
        },
        's0',
      )
        .addFunction('S1', (s) => s.$update('list', [{ n: 1 }]), 's1')
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues: cv });
      executor.setRedactionPolicy({ keys: ['unrelatedSecret'] });
      await executor.run();
      const log = new Set<object>();
      for (const b of executor.getSnapshot().commitLog) {
        containers(b.overwrite, log);
        containers(b.updates, log);
      }
      for (const view of [executor.getSnapshot().sharedState, executor.getSnapshot({ redact: true }).sharedState]) {
        for (const c of containers(view)) expect(log.has(c)).toBe(false);
      }
    },
  );
});

describe('M3 — value semantics: a write changes exactly its own path', () => {
  it('aliased initial state: a nested write through `a` does not change `b` (stock changed both)', async () => {
    const shared = { v: 0 };
    const inner = flowChart<any>(
      'In',
      (s) => {
        s.done = true;
      },
      'in',
    ).build();
    const chart = flowChart<any>(
      'S0',
      (s) => {
        s.seenV = s.a.v; // a read of the aliased value — the alias stays as committed
      },
      's0',
    )
      .addSubFlowChart('sub', inner, 'Sub', { outputMapper: () => ({ a: { x: 1 } }) })
      .build();
    const executor = new FlowChartExecutor(chart, { initialContext: { a: shared, b: shared } });
    await executor.run();
    expect(executor.getSnapshot().sharedState).toMatchObject({ a: { v: 0, x: 1 }, b: { v: 0 } });
    expect((executor.getSnapshot().sharedState as any).b.x).toBeUndefined();
  });
});
