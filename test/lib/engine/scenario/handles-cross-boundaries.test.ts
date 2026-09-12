/**
 * 9.23.3 — a handle the scope handed out is a value the engine accepts back.
 *
 * REGRESSION (9.22.0–9.23.2, found by a consumer's upgrade): `addParallelForEach`
 * over OBJECT items lost every child. The items selector returned the parent
 * scope's array handle, `items[index]` was an element handle (a Proxy bound to
 * the parent stage, 9.22.0), the generated `inputMapper: () => ({ item, index })`
 * seeded the branch with it, and the seed commit's `structuredClone` (9.23.0)
 * threw `DataCloneError` before the branch's first stage ran. Best-effort
 * policy kept the slot as `undefined` — `[null, null]` on the wire, run resolved.
 * 9.21.1 handed the raw element back and worked.
 *
 * THE FIX is one registry (reactive/handles.ts) asked at every boundary where
 * the library carries an app-produced value across a stage: the fan-out
 * selector, a subflow `inputMapper` / `outputMapper`, and the explicit scope
 * doors `$setValue` / `$update` / `$batchArray`.
 *
 * Test types: Regression (the consumer's shape, byte-compared to 9.21.1's
 * result) · Functional (nested arrays, flat, primitive, order) · Security
 * (redaction still covers the seed; a GENUINE uncloneable value still fails
 * loudly under both policies) · Integration (fold of every branch's own log
 * agrees with its state, both encodings; ordinary subflow mappers) · Unit-ish
 * (the explicit doors) · Property (random item shapes round-trip).
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { CommitValuesMode, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stateAt } from '../../../../src/trace.js';

const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

interface Item {
  id: string;
  facts: { latency: number; tags: string[]; when?: Date };
}
interface Parent {
  items?: Item[];
  results?: unknown[];
  [key: string]: unknown;
}
interface Child {
  item?: Item;
  index?: number;
  verdict?: unknown;
  [key: string]: unknown;
}

const ITEMS: Item[] = [
  { id: 'a', facts: { latency: 12, tags: ['x'] } },
  { id: 'b', facts: { latency: 24, tags: ['y', 'z'] } },
];

/** A branch that reads the seeded item DEEPLY and records what it saw. */
function verdictChart() {
  return flowChart<Child>(
    'Judge',
    (c: TypedScope<Child>) => {
      c.verdict = { id: c.item!.id, latency: c.item!.facts.latency, tags: [...c.item!.facts.tags], index: c.index };
    },
    'judge',
  ).build();
}

function fanOutChart(items: () => Item[], failFast?: boolean) {
  return flowChart<Parent>(
    'Seed',
    (s: TypedScope<Parent>) => {
      s.items = items();
    },
    'seed',
  )
    .addParallelForEach('Each item', 'each', {
      items: (s) => s.items ?? [],
      branch: () => verdictChart(),
      maxBranches: 8,
      into: 'results',
      ...(failFast !== undefined && { failFast }),
    })
    .build();
}

type Branch = {
  treeContext: { history: unknown[]; initialState: Record<string, unknown>; globalContext: Record<string, unknown> };
};

function branches(executor: FlowChartExecutor<any, any>): Branch[] {
  const all = executor.getSnapshot().subflowResults ?? {};
  return Object.keys(all)
    .filter((k) => /^each~\d+$/.test(k))
    .sort()
    .map((k) => all[k] as unknown as Branch);
}

describe("9.23.3 the fan-out seeds VALUES, never the parent stage's handles", () => {
  it.each(ENCODINGS)(
    'REGRESSION: object items → every child runs, keeps its input, results in items order (%s)',
    async (commitValues) => {
      const executor = new FlowChartExecutor(
        fanOutChart(() => structuredClone(ITEMS)),
        { commitValues },
      );
      await executor.run();
      const { results } = executor.getSnapshot().sharedState as Parent;

      // What 9.21.1 produced for the same chart — not `[null, null]`.
      expect(results).toEqual([
        { item: ITEMS[0], index: 0, verdict: { id: 'a', latency: 12, tags: ['x'], index: 0 } },
        { item: ITEMS[1], index: 1, verdict: { id: 'b', latency: 24, tags: ['y', 'z'], index: 1 } },
      ]);

      // Each branch's OWN log carries the seed (provenance, not a hidden closure)
      // and folds to the state it served.
      const runs = branches(executor);
      expect(runs).toHaveLength(2);
      runs.forEach((b, i) => {
        expect(b.treeContext.globalContext.item).toEqual(ITEMS[i]);
        const fold = stateAt(b.treeContext, b.treeContext.history.length - 1);
        expect(fold.state).toEqual(b.treeContext.globalContext);
      });
      // The parent's fold agrees too: the results array is one committed value.
      const snap = executor.getSnapshot();
      expect(stateAt(snap, snap.commitLog.length - 1).state).toEqual(snap.sharedState);
    },
  );

  it('nested arrays inside items, flat objects and primitives all cross; order is items order', async () => {
    const shapes: unknown[] = [
      { id: 'n', facts: { latency: 1, tags: ['p', 'q'] }, rows: [[1, 2], [3]] },
      { flat: true, n: 2 },
      'plain',
      7,
      null,
    ];
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.items = shapes;
      },
      'seed',
    )
      .addParallelForEach('Each', 'each', {
        items: (s: any) => s.items,
        branch: () =>
          flowChart<any>(
            'Echo',
            (c: any) => {
              c.echo = c.item;
              c.at = c.index;
            },
            'echo',
          ).build(),
        maxBranches: 8,
        into: 'results',
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const results = (executor.getSnapshot().sharedState as any).results as any[];
    expect(results.map((r) => r.echo)).toEqual(shapes);
    expect(results.map((r) => r.at)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a Date inside an item reaches the child AS A DATE (no JSON round-trip on the way)', async () => {
    const when = new Date('2026-09-12T10:00:00Z');
    const seen: unknown[] = [];
    const chart = flowChart<Parent>(
      'Seed',
      (s: TypedScope<Parent>) => {
        s.$setValue('items', [{ id: 'd', facts: { latency: 1, tags: [], when } }]);
      },
      'seed',
    )
      .addParallelForEach('Each', 'each', {
        items: (s) => s.items ?? [],
        branch: () =>
          flowChart<Child>(
            'Look',
            (c: TypedScope<Child>) => {
              seen.push(c.item!.facts.when);
            },
            'look',
          ).build(),
        maxBranches: 2,
        into: 'results',
      })
      .build();
    await new FlowChartExecutor(chart).run();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Date);
    expect((seen[0] as Date).toISOString()).toBe(when.toISOString());
  });

  it('a subflow inputMapper / outputMapper that hands parent handles on: values cross both ways', async () => {
    const inner = flowChart<any>(
      'Use',
      (c: any) => {
        c.summary = { first: c.picked.id, count: c.all.length };
      },
      'use',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.items = structuredClone(ITEMS);
      },
      'seed',
    )
      .addSubFlowChart('inner', inner, 'Inner', {
        inputMapper: (s: any) => ({ picked: s.items[0], all: s.items }),
        outputMapper: (out: any, parent: any) => ({ summary: out.summary, echoed: parent.items[1] }),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot().sharedState as any;
    expect(state.summary).toEqual({ first: 'a', count: 2 });
    expect(state.echoed).toEqual(ITEMS[1]);
    const snap = executor.getSnapshot();
    expect(stateAt(snap, snap.commitLog.length - 1).state).toEqual(snap.sharedState);
  });
});

describe('9.23.3 the explicit scope doors accept a handle back', () => {
  it.each(ENCODINGS)(
    '$setValue / $update / $batchArray store the value behind a handle; Dates intact; fold agrees (%s)',
    async (commitValues) => {
      const when = new Date('2026-01-02T03:04:05Z');
      const chart = flowChart<any>(
        'Write',
        (s: any) => {
          s.$setValue('customer', { name: 'n', since: when, tags: ['t'] });
          s.$setValue('copy', s.customer); // the handle, not a Proxy the commit could never clone
          s.$update('merged', { inner: s.customer.tags }); // a handle INSIDE a hand-built patch
          s.$batchArray('list', (arr: unknown[]) => {
            arr.push(s.customer); // a handle pushed into the working copy
          });
        },
        'write',
      ).build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();
      const snap = executor.getSnapshot();
      const state = snap.sharedState as any;
      expect(state.copy).toEqual({ name: 'n', since: when, tags: ['t'] });
      expect(state.copy.since).toBeInstanceOf(Date); // `$setValue` keeps the bytes the set trap would not
      expect(state.merged).toEqual({ inner: ['t'] });
      expect(state.list).toEqual([{ name: 'n', since: when, tags: ['t'] }]);
      expect(stateAt(snap, snap.commitLog.length - 1).state).toEqual(state);
    },
  );

  it('a handle-free value passes through by reference (the doors add nothing to the ordinary write)', async () => {
    let handedIn: unknown;
    let stored: unknown;
    const chart = flowChart<any>(
      'Write',
      (s: any) => {
        handedIn = { a: 1, b: [1, 2] };
        s.$setValue('k', handedIn);
        stored = s.$toRaw().getValue('k');
      },
      'write',
    ).build();
    await new FlowChartExecutor(chart).run();
    expect(stored).toBe(handedIn);
  });
});

describe('9.23.3 security — the seed is still redacted, and a GENUINE uncloneable value still fails loudly', () => {
  it.each(ENCODINGS)(
    "a policy on the seeded field scrubs the branch's log and mirror, the branch computes on the real value (%s)",
    async (commitValues) => {
      const seenByBranch: unknown[] = [];
      const chart = flowChart<any>(
        'Seed',
        (s: any) => {
          s.items = [{ id: 'a', facts: { latency: 12, tags: ['x'], secret: 'card-4242' } }];
        },
        'seed',
      )
        .addParallelForEach('Each', 'each', {
          items: (s: any) => s.items,
          branch: () =>
            flowChart<any>(
              'Look',
              (c: any) => {
                seenByBranch.push(c.item.facts.secret);
                c.verdict = c.item.facts.latency;
              },
              'look',
            ).build(),
          maxBranches: 2,
          into: 'results',
        })
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      executor.setRedactionPolicy({ keys: [], fields: { item: ['facts.secret'] } });
      await executor.run();

      expect(seenByBranch).toEqual(['card-4242']); // business logic unaffected
      const [branch] = branches(executor);
      const log = JSON.stringify(branch.treeContext.history);
      expect(log).not.toContain('card-4242');
      expect(log).toContain('REDACTED');
      // The served (redacted) snapshot never carries it either, and its fold is its state.
      const served = executor.getSnapshot({ redact: true });
      const servedBranch = Object.values(served.subflowResults ?? {})[0] as unknown as Branch;
      expect(JSON.stringify(servedBranch.treeContext.globalContext)).not.toContain('card-4242');
      expect(stateAt(servedBranch.treeContext, servedBranch.treeContext.history.length - 1).state).toEqual(
        servedBranch.treeContext.globalContext,
      );
    },
  );

  /**
   * A function cannot even enter state (the set trap's round-trip drops it,
   * `$setValue` of it fails the parent's own commit), so the genuine external
   * case is a selector that BUILDS its items outside the scope. Nothing of
   * ours is in that value; the refusal stays loud.
   */
  function foreignItemsChart(failFast?: boolean) {
    return flowChart<Parent>('Seed', () => undefined, 'seed')
      .addParallelForEach('Each item', 'each', {
        items: () => [{ id: 'fn', facts: { latency: 1, tags: [] }, run: () => 1 } as unknown as Item, ITEMS[1]],
        branch: () => verdictChart(),
        maxBranches: 8,
        into: 'results',
        ...(failFast !== undefined && { failFast }),
      })
      .build();
  }

  it('best-effort: an item carrying a function (nothing of ours) still fails its branch explicitly — slot undefined, error on record', async () => {
    const error = vi.spyOn(console, 'info').mockImplementation(() => undefined); // best-effort reports through the run's logger
    const executor = new FlowChartExecutor(foreignItemsChart());
    await executor.run();
    const snap = executor.getSnapshot();
    const results = (snap.sharedState as Parent).results as unknown[];
    expect(results).toHaveLength(2);
    expect(results[0]).toBeUndefined(); // the slot is kept, never filled in
    expect((results[1] as any).verdict.id).toBe('b'); // the honest sibling still ran
    // The failed branch has no subflow result: nothing of it was recorded as if it ran.
    expect(Object.keys(snap.subflowResults ?? {}).filter((k) => k.startsWith('each~0'))).toEqual([]);
    const reported = error.mock.calls.find(([message]) => typeof message === 'string' && message.includes('each~0'));
    expect(reported).toBeDefined();
    expect(String((reported![1] as { error: unknown }).error)).toContain('could not be cloned');
    error.mockRestore();
  });

  it('fail-fast: the same item rejects the whole stage', async () => {
    await expect(new FlowChartExecutor(foreignItemsChart(true)).run()).rejects.toThrow(/could not be cloned/);
  });
});

describe('9.23.3 property — any cloneable item shape crosses the fan-out unchanged, in order', () => {
  const leaf = fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null), fc.date({ noInvalidDate: true }));
  const value = fc.letrec((tie) => ({
    value: fc.oneof(
      { maxDepth: 3 },
      leaf,
      fc.array(tie('value'), { maxLength: 3 }),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }), tie('value'), { maxKeys: 3 }),
    ),
  })).value;
  // A top-level item is a non-empty plain object, an array or a primitive: the
  // seed spreads an object item into keys (`seedSubflowGlobalStore`, 9.14.0),
  // so `{}` or a bare `Date` AS THE ITEM seeds nothing — a pre-existing
  // limit of the seed's shape, named in the changelog, not this fix's.
  const item = fc.oneof(
    fc.integer(),
    fc.string(),
    fc.array(value, { maxLength: 3 }),
    fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), value, { minKeys: 1, maxKeys: 3 }),
  );

  it('echo(item) deep-equals item for every child', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(item, { minLength: 1, maxLength: 4 }), async (items) => {
        const chart = flowChart<any>(
          'Seed',
          (s: any) => {
            s.$setValue('items', items);
          },
          'seed',
        )
          .addParallelForEach('Each', 'each', {
            items: (s: any) => s.items,
            branch: () =>
              flowChart<any>(
                'Echo',
                (c: any) => {
                  c.$setValue('echo', c.item); // the explicit door keeps Dates (the set trap would not — landmine 1)
                },
                'echo',
              ).build(),
            maxBranches: 4,
            into: 'results',
          })
          .build();
        const executor = new FlowChartExecutor(chart);
        await executor.run();
        const results = (executor.getSnapshot().sharedState as any).results as any[];
        expect(results.map((r) => r.echo)).toEqual(items);
      }),
      { numRuns: 40 },
    );
  });
});
