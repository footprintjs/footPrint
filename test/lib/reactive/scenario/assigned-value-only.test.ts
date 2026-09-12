/**
 * 9.23.0 — the array traps unwrap the ASSIGNED value only.
 *
 * Landmine 1 (closed in 9.24.0): the set trap used to JSON-round-trip the
 * value the caller handed in (a `Date` became a string, a `Map` became `{}`,
 * an own `undefined` dropped). Until 9.23.0 the array commit callbacks
 * applied that round-trip to the WHOLE rebuilt array on every element write
 * — so writing element 2 stringified a `Date` sitting untouched at element
 * 0, and every element write was O(N). 9.23.0 narrowed it to the assigned
 * value; 9.24.0 removed it (the scope's handles are recognised now, so
 * nothing needs copying at the write — the buffer detaches at commit).
 * Pinned here by name:
 *
 *   - a sibling the caller did not touch passes through BY REFERENCE and is
 *     still a `Date` / `Map` after commit and in the fold;
 *   - the value the caller ASSIGNED (an index set, a method argument, an
 *     element-proxy leaf, a whole array) is stored AS ASSIGNED — the same
 *     bytes `$setValue` has always stored;
 *   - a handle assigned or pushed becomes the value behind it.
 *
 * Both `commitValues` encodings; the fold must agree with the live state.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { CommitValuesMode } from '../../../../src/lib/memory/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { stateAt } from '../../../../src/trace';

type State = Record<string, any>;
const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];
const WHEN = '2020-01-01T00:00:00.000Z';

async function run(seed: (s: State) => void, mutate: (s: State) => void, commitValues: CommitValuesMode) {
  const chart = flowChart<State>('seed', seed, 'seed').addFunction('mutate', mutate, 'mutate').build();
  const executor = new FlowChartExecutor(chart, { commitValues });
  await executor.run({ input: {} });
  const snapshot = executor.getSnapshot();
  return {
    state: snapshot.sharedState as State,
    folded: stateAt(snapshot, snapshot.commitLog.length - 1).state as State,
    bundle: snapshot.commitLog[snapshot.commitLog.length - 1],
  };
}

const seedTyped = (s: State) => {
  s.$setValue('arr', [new Date(WHEN), new Map([['a', 1]]), { n: 0 }]);
};

/** The untouched typed elements are still typed, in state AND in the fold. */
function expectSiblingsIntact(view: State) {
  expect(view.arr[0]).toBeInstanceOf(Date);
  expect((view.arr[0] as Date).toISOString()).toBe(WHEN);
  expect(view.arr[1]).toBeInstanceOf(Map);
  expect([...(view.arr[1] as Map<string, number>)]).toEqual([['a', 1]]);
}

describe('9.23.0 — untouched siblings pass through by reference (was: stringified by the whole-array round-trip)', () => {
  it.each(ENCODINGS)(
    'an element-proxy leaf write at index 2 leaves the Date and Map at 0/1 intact (%s)',
    async (cv) => {
      const { state, folded, bundle } = await run(
        seedTyped,
        (s) => {
          s.arr[2].n = 1;
        },
        cv,
      );
      expectSiblingsIntact(state);
      expectSiblingsIntact(folded);
      expect(state.arr[2]).toEqual({ n: 1 });
      expect(folded.arr[2]).toEqual({ n: 1 });
      // The log's value is a clone, typed too (structuredClone keeps Date/Map).
      expect(bundle.overwrite.arr[0]).toBeInstanceOf(Date);
    },
  );

  it.each(ENCODINGS)('an index assignment at 2 leaves 0/1 intact (%s)', async (cv) => {
    const { state, folded } = await run(
      seedTyped,
      (s) => {
        s.arr[2] = { n: 2 };
      },
      cv,
    );
    expectSiblingsIntact(state);
    expectSiblingsIntact(folded);
    expect(state.arr[2]).toEqual({ n: 2 });
  });

  it.each(ENCODINGS)('a mutating method (push / splice) leaves 0/1 intact (%s)', async (cv) => {
    const { state, folded } = await run(
      seedTyped,
      (s) => {
        s.arr.push({ n: 3 });
        s.arr.splice(2, 1);
      },
      cv,
    );
    expectSiblingsIntact(state);
    expectSiblingsIntact(folded);
    expect(state.arr).toHaveLength(3);
    expect(state.arr[2]).toEqual({ n: 3 });
  });

  it.each(ENCODINGS)('a nested array (`s.k.arr`) behaves the same (%s)', async (cv) => {
    const { state, folded } = await run(
      (s) => {
        s.$setValue('k', { arr: [new Date(WHEN), new Map([['a', 1]]), { n: 0 }] });
      },
      (s) => {
        s.k.arr[2].n = 1;
        s.k.arr.push({ n: 3 });
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.k.arr[0]).toBeInstanceOf(Date);
      expect(view.k.arr[1]).toBeInstanceOf(Map);
      expect(view.k.arr[2]).toEqual({ n: 1 });
      expect(view.k.arr[3]).toEqual({ n: 3 });
    }
  });
});

describe('9.24.0 — the ASSIGNED value is stored as assigned (landmine 1 closed: no round-trip on either write path)', () => {
  it.each(ENCODINGS)('an index assignment of a Date stays a Date; a pushed Map stays a Map (%s)', async (cv) => {
    const { state, folded } = await run(
      seedTyped,
      (s) => {
        s.arr[2] = new Date(WHEN);
        s.arr.push(new Map([['b', 2]]));
        s.arr.unshift({ when: new Date(WHEN) });
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.arr[0].when).toBeInstanceOf(Date); // unshift argument: as assigned (was a string until 9.24.0)
      expect(view.arr[0].when.toISOString()).toBe(WHEN);
      expect(view.arr[1]).toBeInstanceOf(Date); // the untouched seed Date, shifted to 1
      expect(view.arr[2]).toBeInstanceOf(Map); // the untouched seed Map, shifted to 2
      expect(view.arr[3]).toBeInstanceOf(Date); // index assignment: as assigned
      expect(view.arr[3].toISOString()).toBe(WHEN);
      expect(view.arr[4]).toBeInstanceOf(Map); // pushed Map: as assigned (was {} until 9.24.0)
      expect([...view.arr[4].entries()]).toEqual([['b', 2]]);
    }
  });

  it.each(ENCODINGS)('an element-proxy leaf assignment of a Date stays a Date (%s)', async (cv) => {
    const { state, folded } = await run(
      seedTyped,
      (s) => {
        s.arr[2].when = new Date(WHEN);
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.arr[2].n).toBe(0);
      expect(view.arr[2].when).toBeInstanceOf(Date);
      expect(view.arr[2].when.toISOString()).toBe(WHEN);
      expect(view.arr[0]).toBeInstanceOf(Date);
    }
  });

  it.each(ENCODINGS)(
    'a proxy pushed or assigned into an array is unwrapped (the case the round-trip used to cover) (%s)',
    async (cv) => {
      const { state, folded } = await run(
        (s) => {
          s.$setValue('customer', { tier: 'gold', tags: ['a'] });
          s.$setValue('arr', [{ n: 0 }]);
        },
        (s) => {
          s.arr.push(s.customer); // a nested proxy as a method argument
          s.arr[0] = s.customer; // a nested proxy as an index assignment
          s.arr[0].tier = 'silver'; // does not reach `customer`
        },
        cv,
      );
      for (const view of [state, folded]) {
        expect(view.arr).toEqual([
          { tier: 'silver', tags: ['a'] },
          { tier: 'gold', tags: ['a'] },
        ]);
        expect(view.customer).toEqual({ tier: 'gold', tags: ['a'] });
      }
    },
  );
});

describe('9.24.0 — a whole-array ASSIGNMENT through the proxy keeps every element as assigned (it IS the assigned value)', () => {
  it.each(ENCODINGS)('top-level `s.arr = [...]` (%s)', async (cv) => {
    const { state, folded } = await run(
      seedTyped,
      (s) => {
        s.arr = [new Date(WHEN), new Map([['a', 1]]), { n: 0, gone: undefined }];
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.arr[0]).toBeInstanceOf(Date);
      expect(view.arr[0].toISOString()).toBe(WHEN);
      expect(view.arr[1]).toBeInstanceOf(Map);
      expect(view.arr[1].get('a')).toBe(1);
      // An own `undefined` is ABSENT to the record (`deepEqual`, 9.19.1): here
      // the seed already held `{ n: 0 }`, so the assignment differs from state
      // in nothing the record can see and the net-change filter drops it —
      // the seed's element stays, own `gone` and all not there.
      expect(view.arr[2]).toEqual({ n: 0 });
      expect(Object.prototype.hasOwnProperty.call(view.arr[2], 'gone')).toBe(false);
    }
  });

  it.each(ENCODINGS)('nested `s.k.arr = [...]` (%s)', async (cv) => {
    const { state, folded } = await run(
      (s) => {
        s.$setValue('k', { arr: [new Date(WHEN)] });
      },
      (s) => {
        s.k.arr = [new Date(WHEN), new Map([['a', 1]])];
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.k.arr[0]).toBeInstanceOf(Date);
      expect(view.k.arr[0].toISOString()).toBe(WHEN);
      expect(view.k.arr[1]).toBeInstanceOf(Map);
    }
  });
});

describe('9.23.0 — the array shape the round-trip used to normalise is still normalised', () => {
  it.each(ENCODINGS)('delete arr[i], a write past the end, and length growth spell holes as null (%s)', async (cv) => {
    const { state, folded } = await run(
      (s) => {
        s.$setValue('a', [1, 2, 3]);
        s.$setValue('b', [1]);
        s.$setValue('c', [1]);
      },
      (s) => {
        delete s.a[1];
        s.b[3] = 4;
        s.c.length = 3;
      },
      cv,
    );
    for (const view of [state, folded]) {
      expect(view.a).toEqual([1, null, 3]);
      expect(Object.keys(view.a)).toEqual(['0', '1', '2']); // a real null, not a hole
      expect(view.b).toEqual([1, null, null, 4]);
      expect(Object.keys(view.b)).toEqual(['0', '1', '2', '3']);
      expect(view.c).toEqual([1, null, null]);
      expect(Object.keys(view.c)).toEqual(['0', '1', '2']);
    }
  });
});

describe('9.24.0 — the two write doors store the SAME bytes (landmine 1 closed)', () => {
  it.each(ENCODINGS)(
    'for any JSON value, `s.k = v` and `s.$setValue(k, v)` commit identical rows and identical state (%s)',
    async (cv) => {
      await fc.assert(
        fc.asyncProperty(fc.jsonValue(), async (v) => {
          const { state, folded, bundle } = await run(
            () => undefined,
            (s) => {
              s.viaTrap = v;
              s.$setValue('viaDoor', v);
            },
            cv,
          );
          const rows = (bundle as any).overwrite ?? {};
          expect(JSON.stringify(rows.viaTrap)).toBe(JSON.stringify(rows.viaDoor));
          expect(state.viaTrap).toEqual(state.viaDoor);
          expect(folded.viaTrap).toEqual(folded.viaDoor);
          expect(folded.viaTrap).toEqual(v);
        }),
        { numRuns: 150 },
      );
    },
  );

  it.each(ENCODINGS)(
    'a typed value (Date / Map / Set) is the same through both doors, in state AND in the fold (%s)',
    async (cv) => {
      const v = { when: new Date(WHEN), m: new Map([['k', 1]]), s: new Set([1]), nested: [{ d: new Date(WHEN) }] };
      const { state, folded } = await run(
        () => undefined,
        (s) => {
          s.viaTrap = v;
          s.$setValue('viaDoor', v);
        },
        cv,
      );
      for (const view of [state, folded]) {
        for (const key of ['viaTrap', 'viaDoor']) {
          expect(view[key].when).toBeInstanceOf(Date);
          expect(view[key].m).toBeInstanceOf(Map);
          expect(view[key].s).toBeInstanceOf(Set);
          expect(view[key].nested[0].d).toBeInstanceOf(Date);
        }
        expect(view.viaTrap).toEqual(view.viaDoor);
      }
    },
  );

  it('a value nothing can clone (a function inside) fails the stage at COMMIT through the trap too — as $setValue always did', async () => {
    const chart = flowChart<State>(
      'w',
      (s) => {
        s.viaTrap = { run: () => 1 };
      },
      'w',
    ).build();
    await expect(new FlowChartExecutor(chart).run({ input: {} })).rejects.toThrow(/could not be cloned/);
  });
});
