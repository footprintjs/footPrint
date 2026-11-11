/**
 * `liveView.ts · liveInspectionTraps` — the Proxy invariant for a property the
 * TARGET owns as non-configurable.
 *
 * The trap used to report every live descriptor as configurable. When the
 * proxy target itself owns that property as non-configurable (an extensible
 * object with an `Object.defineProperty` field), that breaks a Proxy invariant
 * and `Object.keys` / spread throw a TypeError. The trap now answers such a
 * property from the target.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { liveInspectionTraps } from '../../../../src/lib/reactive/liveView';
import { FlowChartExecutor } from '../../../../src/lib/runner';

describe('liveInspectionTraps -- boundary: non-configurable own property on the target', () => {
  it('Object.keys and spread work over a target with a defineProperty field', () => {
    const raw: Record<string, unknown> = { n: 1 };
    Object.defineProperty(raw, 'id', { value: 7, enumerable: true });
    const proxy = new Proxy(
      raw,
      liveInspectionTraps(() => raw),
    );

    expect(Object.keys(proxy)).toEqual(['n', 'id']);
    expect({ ...proxy }).toEqual({ n: 1, id: 7 });
    expect(Object.getOwnPropertyDescriptor(proxy, 'id')).toMatchObject({ value: 7, configurable: false });
  });

  it('a live non-configurable property the target does not own is still reported configurable', () => {
    const target: Record<string, unknown> = {};
    const live: Record<string, unknown> = {};
    Object.defineProperty(live, 'id', { value: 7, enumerable: true });
    const proxy = new Proxy(
      target,
      liveInspectionTraps(() => live),
    );

    expect(Object.getOwnPropertyDescriptor(proxy, 'id')).toMatchObject({ value: 7, configurable: true });
  });

  it('through the typed scope: Object.keys of a held value with a defineProperty field does not throw', async () => {
    let keys: string[] = [];
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        const o: Record<string, unknown> = { n: 1 };
        Object.defineProperty(o, 'id', { value: 7, enumerable: true });
        s.k = o;
        keys = Object.keys(s.k);
      },
      'seed',
    ).build();

    await new FlowChartExecutor(chart).run();
    expect(keys).toEqual(['n', 'id']);
  });
});
