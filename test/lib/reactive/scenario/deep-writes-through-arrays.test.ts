/**
 * Regression: a deep write made THROUGH the typed-scope proxy must reach the
 * commit log — or be refused loudly. It must never be lost in silence.
 *
 * Reported against the shipped build with plain charts and no mocks: writes in
 * a stage that runs AFTER a seed stage created the container.
 *
 *   s.obj.deep.n = 99          landed
 *   s.arr[0].n = 99            landed
 *   s.nested.lines[0].n = 99   LOST   (final value still 1)
 *   s.a.arr[0].n = 99          landed
 *   s.b.arr[0] = { n: 99 }     LOST
 *   s.c.arr[1] = 99            LOST   (primitive element)
 *   s.d.deep.arr[0].n = 99     LOST
 *
 * The same shape landed in one run and was lost in another, which made it look
 * non-deterministic. It was not. TWO deterministic defects were interleaving:
 *
 *   FAMILY A — the proxy chain BROKE at an array index. `createArrayProxy`'s
 *   get trap handed back `current[index]` raw, so `…arr[i].prop = v` was a
 *   plain in-place mutation of a BORROWED read. No trap fired, so there was
 *   never a trace row. Whether the value survived depended on which backing
 *   store the read came from — committed state before the stage's first staged
 *   write (mutated in place: state moved, log empty, the two disagree), the
 *   private transaction-buffer clone after it (dropped at commit). The
 *   "landed" rows above are the FIRST case, which is the worse one.
 *
 *   FAMILY B — a write to an array that is NOT a top-level key committed with
 *   the `merge` verb, and merge's array arm is a set UNION. `[1,2,3]` merged
 *   with the intended `[1,99,3]` became `[1,2,3,99]`. Element replacement,
 *   reordering and shrinking were unrepresentable through any nested array,
 *   and the log recorded the union faithfully — log and state agreed, and both
 *   were wrong against what the stage asked for.
 *
 * These tests assert BOTH halves every time: the final state, and that folding
 * the commit log from `initialState` reproduces it. Every lens in this family
 * answers "what happened" from the log; a write the log cannot see makes the
 * whole record confidently wrong with nothing in it saying so.
 */
import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { PausableHandler } from '../../../../src/lib/builder/types';
import type { CommitValuesMode } from '../../../../src/lib/memory/types';
import { applySmartMerge } from '../../../../src/lib/memory/utils';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { disableDevMode, enableDevMode } from '../../../../src/lib/scope/detectCircular';

type State = Record<string, any>;

/** Replay the commit log from the run's own fold base — what every lens does. */
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

/**
 * Run `seed` then `mutate` and return the final state plus the fold of the log.
 * The two MUST agree — that agreement is the library's whole premise.
 */
async function twoStages(
  seed: (s: State) => void,
  mutate: (s: State) => void,
  commitValues: CommitValuesMode = 'full',
): Promise<{ state: State; folded: State; mutateTrace: { path: string; verb: string }[] }> {
  const chart = flowChart<State>('seed', seed, 'seed').addFunction('mutate', mutate, 'mutate').build();
  const executor = new FlowChartExecutor(chart, { commitValues });
  await executor.run({ input: {} });
  const snapshot = executor.getSnapshot();
  return {
    state: snapshot.sharedState as State,
    folded: foldLog(snapshot as any),
    mutateTrace: (snapshot.commitLog[1].trace ?? []).map((t: any) => ({ path: t.path, verb: t.verb })),
  };
}

// ── The reported table, row by row ─────────────────────────────────────────
// Each row is measured in ISOLATION (so the "first staged write" boundary that
// made family A look random cannot hide a failure) and then again in the exact
// reported SEQUENCE.

const MODES: CommitValuesMode[] = ['full', 'delta'];

for (const mode of MODES) {
  describe(`deep writes through arrays — commitValues: '${mode}'`, () => {
    it('s.obj.deep.n = 99 — the control: a pure object path always landed', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.obj = { deep: { n: 1 } };
        },
        (s) => {
          s.obj.deep.n = 99;
        },
        mode,
      );
      expect(state.obj.deep.n).toBe(99);
      expect(folded.obj.deep.n).toBe(99);
    });

    it('s.arr[0].n = 99 — element property on a TOP-LEVEL array', async () => {
      const { state, folded, mutateTrace } = await twoStages(
        (s) => {
          s.arr = [{ n: 1 }, { n: 2 }];
        },
        (s) => {
          s.arr[0].n = 99;
        },
        mode,
      );
      expect(state.arr).toEqual([{ n: 99 }, { n: 2 }]);
      expect(folded.arr).toEqual([{ n: 99 }, { n: 2 }]);
      // The write is IN the record — not merely present in state by accident.
      expect(mutateTrace).toHaveLength(1);
      expect(mutateTrace[0].path).toBe('arr');
    });

    it('s.nested.lines[0].n = 99 — element property on a NESTED array', async () => {
      const { state, folded, mutateTrace } = await twoStages(
        (s) => {
          s.nested = { lines: [{ n: 1 }] };
        },
        (s) => {
          s.nested.lines[0].n = 99;
        },
        mode,
      );
      expect(state.nested.lines).toEqual([{ n: 99 }]);
      expect(folded.nested.lines).toEqual([{ n: 99 }]);
      expect(mutateTrace).toHaveLength(1);
      expect(mutateTrace[0].path).toBe('nested');
    });

    it('s.b.arr[0] = { n: 99 } — element REPLACE through a nested array', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.b = { arr: [{ n: 1 }, { n: 2 }] };
        },
        (s) => {
          s.b.arr[0] = { n: 99 };
        },
        mode,
      );
      expect(state.b.arr).toEqual([{ n: 99 }, { n: 2 }]);
      expect(folded.b.arr).toEqual([{ n: 99 }, { n: 2 }]);
    });

    it('s.c.arr[1] = 99 — PRIMITIVE element through a nested array', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.c = { arr: [1, 2, 3] };
        },
        (s) => {
          s.c.arr[1] = 99;
        },
        mode,
      );
      expect(state.c.arr).toEqual([1, 99, 3]);
      expect(folded.c.arr).toEqual([1, 99, 3]);
    });

    it('s.d.deep.arr[0].n = 99 — one level deeper', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.d = { deep: { arr: [{ n: 1 }] } };
        },
        (s) => {
          s.d.deep.arr[0].n = 99;
        },
        mode,
      );
      expect(state.d.deep.arr).toEqual([{ n: 99 }]);
      expect(folded.d.deep.arr).toEqual([{ n: 99 }]);
    });

    it('the whole reported sequence in ONE stage — order must not decide the outcome', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.obj = { deep: { n: 1 } };
          s.arr = [{ n: 1 }, { n: 2 }];
          s.nested = { lines: [{ n: 1 }] };
          s.a = { arr: [{ n: 1 }] };
          s.b = { arr: [{ n: 1 }] };
          s.c = { arr: [1, 2, 3] };
          s.d = { deep: { arr: [{ n: 1 }] } };
        },
        (s) => {
          s.obj.deep.n = 99;
          s.arr[0].n = 99;
          s.nested.lines[0].n = 99;
          s.a.arr[0].n = 99;
          s.b.arr[0] = { n: 99 };
          s.c.arr[1] = 99;
          s.d.deep.arr[0].n = 99;
        },
        mode,
      );
      const expected = {
        obj: { deep: { n: 99 } },
        arr: [{ n: 99 }, { n: 2 }],
        nested: { lines: [{ n: 99 }] },
        a: { arr: [{ n: 99 }] },
        b: { arr: [{ n: 99 }] },
        c: { arr: [1, 99, 3] },
        d: { deep: { arr: [{ n: 99 }] } },
      };
      expect(state).toMatchObject(expected);
      expect(folded).toMatchObject(expected);
    });

    it('the mutation is lost neither BEFORE nor AFTER the stage’s first staged write', async () => {
      for (const withPriorWrite of [false, true]) {
        const { state, folded } = await twoStages(
          (s) => {
            s.k = { arr: [{ n: 1 }] };
            s.z = 0;
          },
          (s) => {
            if (withPriorWrite) s.z = 1;
            s.k.arr[0].n = 99;
          },
          mode,
        );
        expect(state.k.arr[0].n, `withPriorWrite=${withPriorWrite}`).toBe(99);
        expect(folded.k.arr[0].n, `withPriorWrite=${withPriorWrite}`).toBe(99);
      }
    });

    it('array METHODS on a nested array replace, shrink and reorder truthfully', async () => {
      const cases: { label: string; mutate: (s: State) => void; expected: unknown }[] = [
        { label: 'push', mutate: (s) => s.k.arr.push(4), expected: [1, 2, 3, 4] },
        { label: 'splice', mutate: (s) => s.k.arr.splice(0, 1), expected: [2, 3] },
        { label: 'sort desc', mutate: (s) => s.k.arr.sort((a: number, b: number) => b - a), expected: [3, 2, 1] },
        { label: 'reverse', mutate: (s) => s.k.arr.reverse(), expected: [3, 2, 1] },
        { label: 'shift', mutate: (s) => s.k.arr.shift(), expected: [2, 3] },
        { label: 'pop', mutate: (s) => s.k.arr.pop(), expected: [1, 2] },
        {
          label: 'length = 1 (shrink)',
          mutate: (s) => {
            s.k.arr.length = 1;
          },
          expected: [1],
        },
        {
          label: 'whole-array reassign shorter',
          mutate: (s) => {
            s.k.arr = [1];
          },
          expected: [1],
        },
      ];
      for (const { label, mutate, expected } of cases) {
        const { state, folded } = await twoStages(
          (s) => {
            s.k = { arr: [1, 2, 3] };
          },
          mutate,
          mode,
        );
        expect(state.k.arr, label).toEqual(expected);
        expect(folded.k.arr, label).toEqual(expected);
      }
    });

    it('an array of arrays writes through both levels', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.g = {
            grid: [
              [1, 2],
              [3, 4],
            ],
          };
        },
        (s) => {
          s.g.grid[0][1] = 99;
          s.g.grid[1].push(5);
        },
        mode,
      );
      expect(state.g.grid).toEqual([
        [1, 99],
        [3, 4, 5],
      ]);
      expect(folded.g.grid).toEqual([
        [1, 99],
        [3, 4, 5],
      ]);
    });

    it('an object INSIDE an element writes through', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.order = { lines: [{ item: { sku: 'A', qty: 1 } }] };
        },
        (s) => {
          s.order.lines[0].item.qty = 4;
        },
        mode,
      );
      expect(state.order.lines[0].item).toEqual({ sku: 'A', qty: 4 });
      expect(folded.order.lines[0].item).toEqual({ sku: 'A', qty: 4 });
    });

    it('an array INSIDE an element writes through', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.order = { lines: [{ tags: ['x'] }] };
        },
        (s) => {
          s.order.lines[0].tags.push('y');
          s.order.lines[0].tags[0] = 'X';
        },
        mode,
      );
      expect(state.order.lines[0].tags).toEqual(['X', 'y']);
      expect(folded.order.lines[0].tags).toEqual(['X', 'y']);
    });

    it('deleting a property of an element writes through', async () => {
      const { state, folded } = await twoStages(
        (s) => {
          s.k = { arr: [{ n: 1, drop: true }] };
        },
        (s) => {
          delete s.k.arr[0].drop;
        },
        mode,
      );
      expect(state.k.arr[0]).toEqual({ n: 1 });
      expect(folded.k.arr[0]).toEqual({ n: 1 });
    });
  });
}

// ── Reads stay borrowed, committed state stays immutable ───────────────────

describe('the write never mutates what it read', () => {
  it('committed state is not edited in place by an element write', async () => {
    let seenDuringMutate: unknown;
    let committedBefore: unknown;
    const chart = flowChart<State>(
      'seed',
      (s) => {
        s.k = { arr: [{ n: 1 }] };
      },
      'seed',
    )
      .addFunction(
        'peek',
        (s) => {
          // A reference taken BEFORE the write, out of committed state.
          committedBefore = s.$getValue('k');
          seenDuringMutate = JSON.stringify(committedBefore);
        },
        'peek',
      )
      .addFunction(
        'mutate',
        (s) => {
          s.k.arr[0].n = 99;
        },
        'mutate',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    // The object the earlier stage borrowed was never edited behind its back.
    expect(JSON.stringify(committedBefore)).toBe(seenDuringMutate);
    expect((executor.getSnapshot().sharedState as State).k.arr[0].n).toBe(99);
  });

  it('reading an element twice in one stage yields equal values, before and after a write', async () => {
    const seen: unknown[] = [];
    const { state } = await twoStages(
      (s) => {
        s.k = { arr: [{ n: 1 }] };
        s.z = 0;
      },
      (s) => {
        seen.push(s.k.arr[0].n);
        s.z = 1;
        seen.push(s.k.arr[0].n);
        s.k.arr[0].n = 99;
        seen.push(s.k.arr[0].n); // read-your-writes
      },
    );
    expect(seen).toEqual([1, 1, 99]);
    expect(state.k.arr[0].n).toBe(99);
  });
});

// ── Writes that already landed must not change ─────────────────────────────

describe('no behaviour change for writes that already landed', () => {
  it('$update keeps its documented array-union merge semantics', async () => {
    const { state, folded } = await twoStages(
      (s) => {
        s.k = { tags: ['a'] };
      },
      (s) => {
        s.$update('k', { tags: ['b'] });
      },
    );
    expect(state.k.tags).toEqual(['a', 'b']);
    expect(folded.k.tags).toEqual(['a', 'b']);
  });

  it('a nested OBJECT write still commits as a merge delta, not a whole-key set', async () => {
    const { mutateTrace, state } = await twoStages(
      (s) => {
        s.order = { id: 'A-1', customer: { tier: 'gold' } };
      },
      (s) => {
        s.order.customer.tier = 'platinum';
      },
    );
    expect(mutateTrace).toEqual([{ path: 'order', verb: 'merge' }]);
    expect(state.order).toEqual({ id: 'A-1', customer: { tier: 'platinum' } });
  });

  it('a top-level array write is unchanged', async () => {
    const { state, folded, mutateTrace } = await twoStages(
      (s) => {
        s.arr = [1, 2, 3];
      },
      (s) => {
        s.arr[1] = 99;
        s.arr.push(4);
      },
    );
    expect(state.arr).toEqual([1, 99, 3, 4]);
    expect(folded.arr).toEqual([1, 99, 3, 4]);
    expect(mutateTrace.every((t) => t.verb === 'set')).toBe(true);
  });

  it('a Date sitting beside a mutated nested array survives the write', async () => {
    const chart = flowChart<State>(
      'seed',
      (s) => {
        s.$setValue('k', { when: new Date('2020-01-01T00:00:00.000Z'), arr: [1] });
      },
      'seed',
    )
      .addFunction(
        'mutate',
        (s) => {
          s.k.arr.push(2);
        },
        'mutate',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    const state = executor.getSnapshot().sharedState as State;
    expect(state.k.arr).toEqual([1, 2]);
    expect(state.k.when).toBeInstanceOf(Date);
  });
});

// ── The one deliberate semantic change ────────────────────────────────────

describe('an array ASSIGNMENT replaces, at every depth (9.22.0)', () => {
  it('scope.k.tags = [...] replaces, the way scope.tags = [...] always did', async () => {
    const { state, folded } = await twoStages(
      (s) => {
        s.tags = ['a'];
        s.k = { tags: ['a'] };
      },
      (s) => {
        s.tags = ['b'];
        s.k.tags = ['b'];
      },
    );
    // Before 9.22.0 the nested one APPENDED (['a','b']) while the top-level one
    // replaced — the same expression meaning two different things by depth.
    expect(state.tags).toEqual(['b']);
    expect(state.k.tags).toEqual(['b']);
    expect(folded.k.tags).toEqual(['b']);
  });

  it('$update is still the explicit append', async () => {
    const { state } = await twoStages(
      (s) => {
        s.k = { tags: ['a'] };
      },
      (s) => {
        s.$update('k', { tags: ['b'] });
      },
    );
    expect(state.k.tags).toEqual(['a', 'b']);
  });

  it('deleting a nested property lands (merge cannot express a removal)', async () => {
    const { state, folded } = await twoStages(
      (s) => {
        s.order = { id: 'A-1', customer: { tier: 'gold', secret: 'x' } };
      },
      (s) => {
        delete s.order.customer.secret;
      },
    );
    expect(state.order.customer).toEqual({ tier: 'gold' });
    expect(folded.order.customer).toEqual({ tier: 'gold' });
  });

  it('deleting an array index empties the slot without touching committed state', async () => {
    const { state, folded } = await twoStages(
      (s) => {
        s.k = { arr: [1, 2, 3] };
      },
      (s) => {
        delete s.k.arr[1];
      },
    );
    // The length is unchanged (JS `delete` semantics) and the emptied slot
    // reads as `null` — JSON's only spelling for an array hole, and state
    // values must survive a JSON round-trip.
    expect(state.k.arr).toEqual([1, null, 3]);
    expect(folded.k.arr).toEqual([1, null, 3]);
  });
});

// ── Subflow ────────────────────────────────────────────────────────────────

describe('subflow', () => {
  it('an element write inside a subflow lands in the subflow log and merges back', async () => {
    const child = flowChart<State>(
      'child-seed',
      (s) => {
        s.out = { lines: (s.$getArgs() as any).lines };
      },
      'child-seed',
    )
      .addFunction(
        'child-mutate',
        (s) => {
          s.out.lines[0].qty = 4;
        },
        'child-mutate',
      )
      .build();

    const parent = flowChart<State>(
      'seed',
      (s) => {
        s.payload = { lines: [{ qty: 1 }] };
      },
      'seed',
    )
      .addSubFlowChart('child', child, 'child', {
        inputMapper: (state: State) => ({ lines: state.payload.lines }),
        outputMapper: (childState: State) => ({ result: childState.out }),
      } as any)
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run({ input: {} });
    const snapshot = executor.getSnapshot();
    expect((snapshot.sharedState as State).result.lines[0].qty).toBe(4);

    // The subflow's OWN log (isolated) must carry the write too.
    const results = snapshot.subflowResults as Record<string, any>;
    const childRun = Object.values(results).find((r: any) => (r?.treeContext?.history ?? []).length > 1) as any;
    expect(childRun, 'subflow history').toBeTruthy();
    const childFold = foldLog({
      initialState: childRun.treeContext.initialState,
      commitLog: childRun.treeContext.history,
    });
    expect(childFold.out.lines[0].qty).toBe(4);
  });
});

// ── Resume ─────────────────────────────────────────────────────────────────

describe('resumed run', () => {
  it('an element write after resume lands in the resumed run’s log', async () => {
    const chart = flowChart<State>(
      'seed',
      (s) => {
        s.k = { arr: [{ n: 1 }] };
      },
      'seed',
    )
      .addPausableFunction(
        'gate',
        {
          execute: async () => ({ question: 'go?' }),
          resume: async (s: State) => {
            s.k.arr[0].n = 99;
          },
        } as PausableHandler<State, unknown>,
        'gate',
      )
      .addFunction(
        'after',
        (s) => {
          s.k.arr.push({ n: 2 });
        },
        'after',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    const first = await executor.run({ input: {} });
    expect((first as any).paused ?? (first as any).status === 'paused').toBeTruthy();
    const checkpoint = (first as any).checkpoint ?? (first as any).pause?.checkpoint;
    expect(checkpoint, 'checkpoint').toBeTruthy();

    const resumed = new FlowChartExecutor(chart);
    await resumed.resume(checkpoint, { ok: true });
    const snapshot = resumed.getSnapshot();
    const state = snapshot.sharedState as State;
    expect(state.k.arr).toEqual([{ n: 99 }, { n: 2 }]);
    expect(foldLog(snapshot as any).k.arr).toEqual([{ n: 99 }, { n: 2 }]);
  });
});

// ── What the proxy CANNOT see is refused loudly, never lost silently ───────

describe('dev-mode guard for mutations the proxy cannot see', () => {
  it('warns, naming the key and the path, when a stage mutates a value it only read', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await twoStages(
        (s) => {
          s.order = { lines: [{ qty: 1 }] };
        },
        (s) => {
          // `.find()` hands back the RAW element — no proxy can be involved.
          const line = s.order.lines.find((l: any) => l.qty === 1);
          line.qty = 4;
        },
      );
      const messages = warn.mock.calls.map((c) => String(c[0]));
      const hit = messages.find((m) => m.includes('order'));
      expect(hit, messages.join('\n')).toBeTruthy();
      expect(hit).toContain('lines');
      expect(hit).toContain('$setValue');
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });

  it('stays silent for writes the proxy DID see', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await twoStages(
        (s) => {
          s.order = { lines: [{ qty: 1 }] };
        },
        (s) => {
          s.order.lines[0].qty = 4;
        },
      );
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([]);
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });

  it('costs nothing and says nothing outside dev mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await twoStages(
        (s) => {
          s.order = { lines: [{ qty: 1 }] };
        },
        (s) => {
          const line = s.order.lines.find((l: any) => l.qty === 1);
          line.qty = 4;
        },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
