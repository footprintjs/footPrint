/**
 * Regression: a key named `__proto__` is DATA through every write door.
 *
 * The element door rebuilt the owning array with a plain assignment,
 * `next[segment] = value`. With the segment `__proto__` that ran the
 * prototype setter on the copy: the value was readable in the stage as an
 * inherited property and then lost at commit, with no row. The object door
 * stored an own `__proto__` key for the same write. Both doors now store an
 * own data property (`reactive/structuralWrite.ts · putOwn`).
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type Door = 'object' | 'element';

async function writeThrough(door: Door, key: string) {
  const seen: { inherited?: unknown; own?: boolean } = {};
  const chart = flowChart<any>(
    'Seed',
    (s) => {
      s.obj = { a: 1 };
      s.arr = [{ a: 1 }];
    },
    'seed',
  )
    .addFunction(
      'Write',
      (s) => {
        const target = door === 'object' ? s.obj : s.arr[0];
        target[key] = { evil: 1 };
        const after = door === 'object' ? s.obj : s.arr[0];
        seen.inherited = after.evil;
        seen.own = Object.hasOwn(after, key);
      },
      'write',
    )
    .build();
  const ex = new FlowChartExecutor(chart);
  await ex.run();
  const snap = ex.getSnapshot();
  const stored = door === 'object' ? snap.sharedState.obj : snap.sharedState.arr[0];
  const rows = snap.commitLog.find((b) => b.stageId === 'write')?.trace ?? [];
  return { seen, stored, rows };
}

describe('reactive scenario -- a `__proto__` key is data through every door', () => {
  it('the object door and the element door store the same own key', async () => {
    const viaObject = await writeThrough('object', '__proto__');
    const viaElement = await writeThrough('element', '__proto__');

    for (const result of [viaObject, viaElement]) {
      expect(result.seen.own).toBe(true);
      expect(result.seen.inherited).toBeUndefined();
      expect(Object.hasOwn(result.stored, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(result.stored)).toBe(Object.prototype);
      expect(JSON.stringify(result.stored)).toBe('{"a":1,"__proto__":{"evil":1}}');
    }
    expect((Object.prototype as any).evil).toBeUndefined();
  });

  it('each door records the row it records for an ordinary key', async () => {
    for (const door of ['object', 'element'] as const) {
      const special = await writeThrough(door, '__proto__');
      const ordinary = await writeThrough(door, 'plain');
      expect(special.rows.length).toBe(1);
      expect(special.rows).toEqual(ordinary.rows);
    }
  });
});
