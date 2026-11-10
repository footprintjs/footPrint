/**
 * Regression: an own key named `constructor` is DATA, not a type marker.
 *
 * The allowlist used to recognise a plain object by reading `.constructor`.
 * State such as `{ constructor: 'Foo', n: 1 }` then failed the check, was handed
 * back raw, and `scope.meta.n = 2` edited committed state in place: the final
 * state moved and the commit log had no row for it. A plain object is now
 * recognised by its prototype (`reactive/allowlist.ts · isPlainObject`).
 */
import { applySmartMerge } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

describe('reactive scenario -- an own `constructor` key is data', () => {
  it('a nested write commits a row, and the `constructor` key survives as data', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.meta = { constructor: 'Foo', n: 1 };
      },
      'seed',
    )
      .addFunction(
        'Edit',
        (s) => {
          s.meta.n = 2;
        },
        'edit',
      )
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run();
    const snap = ex.getSnapshot();

    expect(snap.sharedState.meta).toEqual({ constructor: 'Foo', n: 2 });

    const edit = snap.commitLog.find((b) => b.stageId === 'edit');
    expect(edit?.trace.map((t) => t.path)).toContain('meta');

    let folded: any = structuredClone(snap.initialState ?? {});
    for (const b of snap.commitLog) {
      folded = applySmartMerge(folded, b.updates ?? {}, b.overwrite ?? {}, (b.trace ?? []) as any);
    }
    expect(folded.meta).toEqual({ constructor: 'Foo', n: 2 });
  });
});
