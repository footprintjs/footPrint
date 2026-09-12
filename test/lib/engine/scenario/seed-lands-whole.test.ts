/**
 * 9.24.0 — a subflow seed value with no fields to spread lands WHOLE.
 *
 * `seedSubflowGlobalStore` spreads an object seed into per-field writes (a
 * row and a redaction verdict per field). Since 9.14.0 it spread EVERY
 * non-array object that way, so a value with no enumerable fields — an empty
 * `{}`, a `Date`, a `Map`, a `Set`, a class instance — became zero writes and
 * the child read `undefined` for it. Named in the 9.23.3 changelog; closed
 * here. The merge-back had the same hole for the typed values (a `Date`
 * handed back by an `outputMapper` vanished); an empty object there still
 * merges nothing — the parent's value stands, which is what a merge of
 * nothing means.
 *
 * Test types: Functional (each shape, both doors) · Integration (fan-out
 * items, ordinary mount, both `commitValues` encodings, fold = state) ·
 * Regression (a non-empty plain object still spreads — the per-field rows
 * the redaction verdicts rely on are byte-identical).
 */
import { describe, expect, it } from 'vitest';

import type { CommitValuesMode } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stateAt } from '../../../../src/trace.js';

const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];
const WHEN = new Date('2026-09-12T12:00:00Z');

class Box {
  constructor(public readonly held: number) {}
}

describe('9.24.0 the fan-out seeds an item with no fields WHOLE', () => {
  it.each(ENCODINGS)(
    '`{}`, a Date, a Map, a Set and a class instance each reach the child as themselves (%s)',
    async (commitValues) => {
      const seen: unknown[] = [];
      const chart = flowChart<any>(
        'Seed',
        (s: any) => {
          s.$setValue('items', [{}, WHEN, new Map([['k', 1]]), new Set([1, 2]), new Box(7)]);
        },
        'seed',
      )
        .addParallelForEach('Each', 'each', {
          items: (s: any) => s.items,
          branch: () =>
            flowChart<any>(
              'Look',
              (c: any) => {
                seen.push(c.$getValue('item'));
                c.saw = c.index;
              },
              'look',
            ).build(),
          maxBranches: 8,
          into: 'results',
        })
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();

      expect(seen).toHaveLength(5);
      expect(seen[0]).toEqual({}); // was `undefined` until 9.24.0
      expect(seen[1]).toBeInstanceOf(Date);
      expect((seen[1] as Date).toISOString()).toBe(WHEN.toISOString());
      expect(seen[2]).toBeInstanceOf(Map);
      expect([...(seen[2] as Map<string, number>)]).toEqual([['k', 1]]);
      expect(seen[3]).toBeInstanceOf(Set);
      expect([...(seen[3] as Set<number>)]).toEqual([1, 2]);
      // structuredClone keeps a class instance's OWN fields, not its prototype.
      expect(seen[4]).toEqual({ held: 7 });

      const results = (executor.getSnapshot().sharedState as any).results as any[];
      expect(results.map((r) => r.saw)).toEqual([0, 1, 2, 3, 4]);
      expect(results[0].item).toEqual({});
      expect(results[1].item).toBeInstanceOf(Date);
      const snap = executor.getSnapshot();
      expect(stateAt(snap, snap.commitLog.length - 1).state).toEqual(snap.sharedState);
    },
  );

  it('REGRESSION: a non-empty plain object still spreads into per-field rows', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.$setValue('items', [{ id: 'a', facts: { n: 1 } }]);
      },
      'seed',
    )
      .addParallelForEach('Each', 'each', {
        items: (s: any) => s.items,
        branch: () => flowChart<any>('Look', () => undefined, 'look').build(),
        maxBranches: 2,
        into: 'results',
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const branch = executor.getSnapshot().subflowResults!['each~0'] as any;
    const seedRow = branch.treeContext.history[0];
    // Spread: the seed bundle carries `item` as an object patch of its fields, not one opaque value.
    expect(seedRow.updates?.item ?? seedRow.overwrite?.item).toEqual({ id: 'a', facts: { n: 1 } });
    expect(seedRow.trace.map((t: any) => t.path)).toEqual(expect.arrayContaining([expect.stringContaining('item')]));
    expect(branch.treeContext.globalContext.item).toEqual({ id: 'a', facts: { n: 1 } });
  });
});

describe('9.24.0 the ordinary mount: inputMapper and outputMapper', () => {
  it.each(ENCODINGS)(
    'an inputMapper value with no fields lands whole; an outputMapper Date lands whole; `{}` out merges nothing (%s)',
    async (commitValues) => {
      let childSaw: Record<string, unknown> = {};
      const inner = flowChart<any>(
        'Use',
        (c: any) => {
          childSaw = { empty: c.$getValue('empty'), when: c.$getValue('when'), tags: c.$getValue('tags') };
          c.finished = WHEN;
        },
        'use',
      ).build();
      const chart = flowChart<any>(
        'Seed',
        (s: any) => {
          s.$setValue('summary', { kept: true });
        },
        'seed',
      )
        .addSubFlowChart('inner', inner, 'Inner', {
          inputMapper: () => ({ empty: {}, when: WHEN, tags: new Set(['x']) }),
          outputMapper: (out: any) => ({ finishedAt: out.finished, summary: {} }),
        })
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();

      expect(childSaw.empty).toEqual({});
      expect(childSaw.when).toBeInstanceOf(Date);
      expect(childSaw.tags).toBeInstanceOf(Set);

      const snap = executor.getSnapshot();
      const state = snap.sharedState as any;
      expect(state.finishedAt).toBeInstanceOf(Date); // vanished until 9.24.0
      expect(state.summary).toEqual({ kept: true }); // `{}` merged nothing — the parent's value stands
      expect(stateAt(snap, snap.commitLog.length - 1).state).toEqual(state);
    },
  );
});
