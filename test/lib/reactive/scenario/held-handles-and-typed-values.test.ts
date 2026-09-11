/**
 * Found in review of 9.22.0 — four shapes that still lost a write with NO
 * trace row, after the packet's own table (deep writes through arrays) was
 * green. Every test here was RED against the packet before its fix:
 *
 *   1. `$setValue('k', new Date(1999))` over a 2020 date was dropped as a
 *      no-op: `deepEqual` walked own enumerable keys, and a Date/Map/Set has
 *      none, so any two compared equal (`memory/utils.ts · equalPairs`).
 *   2. `$batchArray('k', a => { a[0].n = 9 })` handed the stage the COMMITTED
 *      elements (shallow `[...current]`), so the edit changed committed state
 *      in place with no row (`createTypedScope.ts · METHOD_ROUTES.$batchArray`).
 *   3. A held element proxy read from the object captured at creation, so
 *      `line.n += 1` twice gave 2 — two honest rows, wrong value
 *      (`arrayTraps.ts · createElementProxy`).
 *   4. A proxy captured in stage A and written in stage B wrote into A's dead
 *      frame — nothing ever committed it (`ScopeFacade.assertLive`).
 *
 * The law under test: every write the scope can reach produces a trace row,
 * and fold(initialState, commitLog) === sharedState.
 */

import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { CommitValuesMode } from '../../../../src/lib/memory/types';
import { applySmartMerge } from '../../../../src/lib/memory/utils';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { disableDevMode, enableDevMode } from '../../../../src/lib/scope/detectCircular';

type State = Record<string, any>;

function foldLog(snapshot: {
  initialState?: Record<string, unknown>;
  commitLog: readonly { updates?: any; overwrite?: any; trace?: any[] }[];
}): Record<string, any> {
  let folded: any = structuredClone(snapshot.initialState ?? {});
  for (const b of snapshot.commitLog) {
    folded = applySmartMerge(folded, b.updates ?? {}, b.overwrite ?? {}, (b.trace ?? []) as any);
  }
  return folded;
}

/** seed → [extra stages…] → mutate. The fold and the state MUST agree. */
async function stages(
  seed: (s: State) => void,
  mutate: (s: State) => void,
  options: { commitValues?: CommitValuesMode; extra?: [string, (s: State) => void][] } = {},
) {
  let builder = flowChart<State>('seed', seed, 'seed');
  for (const [id, fn] of options.extra ?? []) builder = builder.addFunction(id, fn, id);
  const chart = builder.addFunction('mutate', mutate, 'mutate').build();
  const executor = new FlowChartExecutor(chart, { commitValues: options.commitValues ?? 'full' });
  await executor.run({ input: {} });
  const snapshot = executor.getSnapshot();
  const last = snapshot.commitLog[snapshot.commitLog.length - 1];
  return {
    state: snapshot.sharedState as State,
    folded: foldLog(snapshot as any),
    trace: (last.trace ?? []).map((t: any) => ({ path: t.path, verb: t.verb })),
  };
}

// ── 1. Typed values: Date / Map / Set are compared by value, not by key count ──

for (const commitValues of ['full', 'delta'] as CommitValuesMode[]) {
  describe(`typed values through $setValue — commitValues: '${commitValues}'`, () => {
    it('a new Date over an old one commits a row and the fold agrees', async () => {
      const { state, folded, trace } = await stages(
        (s) => s.$setValue('k', new Date('2020-01-01T00:00:00Z')),
        (s) => s.$setValue('k', new Date('1999-01-01T00:00:00Z')),
        { commitValues },
      );
      expect(state.k).toBeInstanceOf(Date);
      expect(state.k.getUTCFullYear()).toBe(1999);
      expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
      expect(folded).toEqual(state);
    });

    it('a new Set over an old one commits a row and the fold agrees', async () => {
      const { state, folded, trace } = await stages(
        (s) => s.$setValue('k', new Set(['a'])),
        (s) => s.$setValue('k', new Set(['b'])),
        { commitValues },
      );
      expect(state.k).toBeInstanceOf(Set);
      expect([...state.k]).toEqual(['b']);
      expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
      expect(folded).toEqual(state);
    });

    it('a new Map over an old one commits a row and the fold agrees', async () => {
      const { state, folded, trace } = await stages(
        (s) => s.$setValue('k', new Map([['a', 1]])),
        (s) => s.$setValue('k', new Map([['a', 2]])),
        { commitValues },
      );
      expect(state.k).toBeInstanceOf(Map);
      expect(state.k.get('a')).toBe(2);
      expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
      expect(folded).toEqual(state);
    });

    it('a Date nested in an object, replaced whole through $setValue', async () => {
      const { state, folded, trace } = await stages(
        (s) => s.$setValue('k', { when: new Date('2020-01-01T00:00:00Z'), keep: 1 }),
        (s) => s.$setValue('k', { when: new Date('1999-01-01T00:00:00Z'), keep: 1 }),
        { commitValues },
      );
      expect(state.k.when.getUTCFullYear()).toBe(1999);
      expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
      expect(folded).toEqual(state);
    });

    it('re-writing an EQUAL Date / Set / Map is still a no-op (no row)', async () => {
      const { trace } = await stages(
        (s) => {
          s.$setValue('d', new Date('2020-01-01T00:00:00Z'));
          s.$setValue('t', new Set(['a', 'b']));
          s.$setValue('m', new Map([['a', { n: 1 }]]));
        },
        (s) => {
          s.$setValue('d', new Date('2020-01-01T00:00:00Z'));
          s.$setValue('t', new Set(['b', 'a']));
          s.$setValue('m', new Map([['a', { n: 1 }]]));
        },
        { commitValues },
      );
      expect(trace).toEqual([]);
    });
  });
}

describe('typed values mutated IN PLACE are now seen by the dev-mode guard', () => {
  it('setFullYear on a borrowed Date warns with the path', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await stages(
        (s) => s.$setValue('k', { when: new Date('2020-01-01T00:00:00Z') }),
        (s) => {
          s.k.when.setUTCFullYear(1999); // a Date is not proxied — this is a borrowed read
        },
      );
      const hit = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('IN PLACE'));
      expect(hit, 'expected the borrowed-mutation warning').toBeTruthy();
      expect(hit).toContain('k.when');
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });

  it('Set.add on a borrowed Set warns with the path', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await stages(
        (s) => s.$setValue('k', { tags: new Set(['a']) }),
        (s) => {
          s.k.tags.add('b');
        },
      );
      const hit = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('IN PLACE'));
      expect(hit).toBeTruthy();
      expect(hit).toContain('k.tags');
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });
});

// ── 2. $batchArray works on a DEEP copy ────────────────────────────────────

describe('$batchArray hands the stage a deep copy', () => {
  it('an element edited inside the batch commits a row and never touches committed state', async () => {
    let held: any;
    const { state, folded, trace } = await stages(
      (s) => {
        s.k = [{ n: 1 }];
      },
      (s) => {
        s.$batchArray('k', (arr: any[]) => {
          arr[0].n = 9;
        });
      },
      { extra: [['hold', (s) => (held = s.$getValue('k'))]] },
    );
    expect(state.k).toEqual([{ n: 9 }]);
    expect(held, 'the committed value read in the earlier stage').toEqual([{ n: 1 }]);
    expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
    expect(folded).toEqual(state);
  });

  it('stays silent in dev mode — the write is in the record', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await stages(
        (s) => {
          s.k = [{ n: 1 }];
        },
        (s) => {
          s.$batchArray('k', (arr: any[]) => {
            arr[0].n = 9;
          });
        },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });
});

// ── 3. A held element proxy reads its own writes ───────────────────────────

describe('a held element proxy reads through the CURRENT value', () => {
  it('line.n += 1 twice → 3', async () => {
    const { state, folded, trace } = await stages(
      (s) => {
        s.k = { arr: [{ n: 1 }] };
      },
      (s) => {
        const line = s.k.arr[0];
        line.n += 1;
        line.n += 1;
      },
    );
    expect(state.k.arr[0].n).toBe(3);
    expect(trace).toEqual([
      { path: 'k', verb: 'set' },
      { path: 'k', verb: 'set' },
    ]);
    expect(folded).toEqual(state);
  });

  it('line.qty = 2; line.total = line.qty * 10 → 20', async () => {
    const { state, folded } = await stages(
      (s) => {
        s.k = { arr: [{ qty: 1, total: 0 }] };
      },
      (s) => {
        const line = s.k.arr[0];
        line.qty = 2;
        line.total = line.qty * 10;
      },
    );
    expect(state.k.arr[0]).toEqual({ qty: 2, total: 20 });
    expect(folded).toEqual(state);
  });

  it("line.x = 1; 'x' in line, Object.keys(line), JSON.stringify(line) all see it", async () => {
    const { state } = await stages(
      (s) => {
        s.k = { arr: [{ n: 1 }] };
      },
      (s) => {
        const line = s.k.arr[0];
        line.x = 1;
        // eslint-disable-next-line no-restricted-syntax -- the `has` trap is what is under test
        s.inn = 'x' in line;
        s.keys = Object.keys(line);
        s.json = JSON.stringify(line);
        s.readback = line.x;
      },
    );
    expect(state.inn).toBe(true);
    expect(state.keys).toEqual(['n', 'x']);
    expect(state.json).toBe('{"n":1,"x":1}');
    expect(state.readback).toBe(1);
  });

  it('a nested object inside a held element reads its own writes too', async () => {
    const { state, folded } = await stages(
      (s) => {
        s.k = { arr: [{ o: { x: 1 } }] };
      },
      (s) => {
        const o = s.k.arr[0].o;
        o.x += 1;
        o.x += 1;
      },
    );
    expect(state.k.arr[0].o.x).toBe(3);
    expect(folded).toEqual(state);
  });

  it('a held NESTED object proxy reads through the current value too (same root, one law)', async () => {
    const { state, folded, trace } = await stages(
      (s) => {
        s.k = { o: { x: 1, a: 1 } };
      },
      (s) => {
        const o = s.k.o;
        o.x += 1;
        o.x += 1;
        o.a = 2;
        o.b = o.a * 10;
        o.y = 1;
        // eslint-disable-next-line no-restricted-syntax -- the `has` trap is what is under test
        s.inn = 'y' in o;
        s.keys = Object.keys(o);
      },
    );
    expect(state.k.o).toEqual({ x: 3, a: 2, b: 20, y: 1 });
    expect(state.inn).toBe(true);
    expect(state.keys).toEqual(['x', 'a', 'b', 'y']);
    expect(trace.filter((t) => t.path === 'k').every((t) => t.verb === 'merge')).toBe(true);
    expect(folded).toEqual(state);
  });

  it('a held TOP-LEVEL object proxy reads through the current value too', async () => {
    const { state, folded } = await stages(
      (s) => {
        s.k = { x: 1, a: 1 };
      },
      (s) => {
        const k = s.k;
        k.x += 1;
        k.x += 1;
        k.a = 2;
        k.b = k.a * 10;
        k.y = 1;
        // eslint-disable-next-line no-restricted-syntax -- the `has` trap is what is under test
        s.inn = 'y' in k;
        s.json = JSON.stringify(k);
      },
    );
    expect(state.k).toEqual({ x: 3, a: 2, b: 20, y: 1 });
    expect(state.inn).toBe(true);
    expect(state.json).toBe('{"x":3,"a":2,"b":20,"y":1}');
    expect(folded).toEqual(state);
  });

  it('a held object proxy whose key was deleted falls back to what it captured — and does not throw', async () => {
    const { state } = await stages(
      (s) => {
        s.k = { o: { x: 1 } };
      },
      (s) => {
        const o = s.k.o;
        delete s.k.o;
        s.readback = o.x;
      },
    );
    expect(state.k).toEqual({});
    expect(state.readback).toBe(1);
  });

  it('after the array is emptied the held handle falls back to what it captured — and does not throw', async () => {
    const { state } = await stages(
      (s) => {
        s.k = { arr: [{ n: 1 }] };
      },
      (s) => {
        const line = s.k.arr[0];
        s.k.arr.length = 0;
        s.readback = line.n; // the slot is gone; the captured object answers
      },
    );
    expect(state.k.arr).toEqual([]);
    expect(state.readback).toBe(1);
  });
});

// ── 4. A handle held past its stage is REFUSED, never silently dropped ──────

describe('a scope handle held past its stage', () => {
  async function runHeld(
    capture: (s: State) => void,
    write: (s: State) => void,
  ): Promise<{ error: Error | undefined; state: State }> {
    const chart = flowChart<State>(
      'seed',
      (s) => {
        s.k = { n: 1, arr: [1] };
      },
      'seed',
    )
      .addFunction('A', capture, 'A')
      .addFunction('B', write, 'B')
      .build();
    const executor = new FlowChartExecutor(chart);
    let error: Error | undefined;
    try {
      await executor.run({ input: {} });
    } catch (e) {
      error = e as Error;
    }
    return { error, state: executor.getSnapshot().sharedState as State };
  }

  it('a nested proxy captured in A and written in B throws, naming A', async () => {
    let held: any;
    const { error, state } = await runHeld(
      (s) => (held = s.k),
      () => {
        held.n = 9;
      },
    );
    expect(error?.message).toContain('Stage "A" (A#1) has already committed');
    expect(error?.message).toContain('`k`');
    expect(state.k.n).toBe(1);
  });

  it('an array proxy captured in A and pushed in B throws', async () => {
    let held: any;
    const { error, state } = await runHeld(
      (s) => (held = s.k.arr),
      () => {
        held.push(2);
      },
    );
    expect(error?.message).toContain('Stage "A" (A#1) has already committed');
    expect(state.k.arr).toEqual([1]);
  });

  it('an element proxy captured in A and written in B throws', async () => {
    let held: any;
    const { error } = await runHeld(
      (s) => {
        s.list = [{ n: 1 }];
        held = s.list[0];
      },
      () => {
        held.n = 9;
      },
    );
    expect(error?.message).toContain('Stage "A" (A#1) has already committed');
  });

  it('the whole scope captured in A and used in B throws — $setValue included', async () => {
    let held: any;
    const { error } = await runHeld(
      (s) => (held = s),
      () => {
        held.$setValue('k', { n: 9 });
      },
    );
    expect(error?.message).toContain('Stage "A" (A#1) has already committed');
  });

  it('the refusal is attributed to the stage that wrote (B), in the narrative and the log', async () => {
    let held: any;
    const chart = flowChart<State>('seed', (s) => (s.k = { n: 1 }), 'seed')
      .addFunction('A', (s) => (held = s.k), 'A')
      .addFunction(
        'B',
        () => {
          held.n = 9;
        },
        'B',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    const errors: string[] = [];
    executor.attachFlowRecorder({
      id: 'r',
      onError: (e: any) => errors.push(e.stageName ?? e.stage ?? JSON.stringify(e)),
    } as any);
    await expect(executor.run({ input: {} })).rejects.toThrow('has already committed');
    expect(errors).toContain('B');
    // A's frame committed exactly once; B's error-path commit is empty.
    const log = executor.getSnapshot().commitLog;
    expect(log.map((b) => b.stageId)).toEqual(['seed', 'A', 'B']);
    expect(log[2].trace).toEqual([]);
  });

  it('reads through a held handle are not refused (only writes are)', async () => {
    let held: any;
    const { error, state } = await runHeld(
      (s) => (held = s.k),
      (s) => {
        s.copy = held.n;
      },
    );
    expect(error).toBeUndefined();
    expect(state.copy).toBe(1);
  });

  it("the engine's own second staging round is NOT a dead handle: a subflow branch merges back into a committed decider frame", async () => {
    const inner = flowChart<State>('inner', (s) => s.$setValue('w', 5), 'inner').build();
    const chart = flowChart<State>('seed', (s) => (s.k = 1), 'seed')
      .addDeciderFunction('route', () => 'sf', 'route')
      .addSubFlowChartBranch('sf', inner, 'mount', {
        inputMapper: () => ({}),
        outputMapper: (child: State) => ({ fromChild: child.w }),
      })
      .addFunctionBranch('plain', 'plain', () => undefined)
      .setDefault('plain')
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    const snapshot = executor.getSnapshot();
    expect((snapshot.sharedState as State).fromChild).toBe(5);
    expect(foldLog(snapshot as any)).toEqual(snapshot.sharedState);
  });
});
