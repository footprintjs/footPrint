/**
 * Property — a different value always commits a row; the same value never does (9.45.0).
 *
 * Over every kind a record can hold (test/helpers/valueKinds.ts · `cloneable`: plain objects, arrays,
 * class instances, Date, RegExp, Map, Set, every Error type, boxed primitives, buffers — resizable
 * too — every typed array, DataView, Blob, nested), a stage writes `a` and the next
 * writes `b`. The second commits a row on `v` exactly when a record holds something different for
 * them, by an oracle that never asks the library (`recordKey`: tags, `structuredClone`,
 * `v8.serialize`); and live state and the record then hold `b`, else `a`.
 *
 * Pairs come three ways: independent (small domains, so near-misses are common), `b` a clone of `a`
 * (the same content — an opaque value inside is never the same one), and `b` the very object `a`.
 * Red before 9.45.0: the first counterexample is two RegExps, buffers or errors that differ.
 */
import fc from 'fast-check';

import { flowChart, FlowChartExecutor } from '../../../../src';
import { commitValueAt } from '../../../../src/trace';
import { cloneable, recordKey } from '../../../helpers/valueKinds';

const pairs: fc.Arbitrary<[unknown, unknown]> = fc.oneof(
  fc.tuple(cloneable, cloneable),
  cloneable.map((a): [unknown, unknown] => [a, structuredClone(a)]),
  cloneable.map((a): [unknown, unknown] => [a, a]),
);

async function replace(a: unknown, b: unknown) {
  const chart = flowChart(
    'Seed',
    (scope: any) => {
      scope.$setValue('v', a);
    },
    'seed',
  )
    .addFunction(
      'Replace',
      (scope: any) => {
        scope.$setValue('v', b);
      },
      'replace',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return executor.getSnapshot();
}

describe('property — a different value always commits a row', () => {
  it('rows on v ⇔ the record holds something different; live state and the record hold the winner', async () => {
    await fc.assert(
      fc.asyncProperty(pairs, async ([a, b]) => {
        // What stage two is compared against is stage one's COMMITTED value — a clone of `a`.
        const different = recordKey(structuredClone(a)) !== recordKey(b);
        const snapshot = await replace(a, b);
        const rows = snapshot.commitLog[1].trace.filter((row) => row.path === 'v').length;
        expect(rows > 0).toBe(different);
        const winner = recordKey(different ? b : a, 'kind');
        expect(recordKey(snapshot.sharedState.v, 'kind')).toBe(winner);
        expect(recordKey(commitValueAt(snapshot.commitLog, 1, 'v'), 'kind')).toBe(winner);
      }),
      { numRuns: 400 },
    );
  });
});
