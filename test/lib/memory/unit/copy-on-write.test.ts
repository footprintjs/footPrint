/** The retained engine-baseline differential; the record's own unit laws live in foottrace. */
import { applySmartMerge as baselineApplySmartMerge } from 'footprintjs-baseline/advanced';
import { type MemoryPatch, type TraceEntry, applySmartMerge } from 'foottrace';
import { normaliseStateKey } from 'foottrace/paths';
import { describe, expect, it } from 'vitest';

import { containersOf } from '../property/copy-on-write-fixture';

describe('public fold — comparison with the published engine baseline', () => {
  const nested = (): { base: any; updates: MemoryPatch; overwrite: MemoryPatch; trace: TraceEntry[] } => {
    const shared = { v: 0 };
    return {
      base: { a: shared, b: shared, list: [{ n: 1 }], keep: { deep: { x: 1 } } },
      updates: { list: [{ n: 2 }] },
      overwrite: { a: { x: 1 }, fresh: { y: [1, 2] } },
      trace: [
        { path: normaliseStateKey(['a', 'x']), verb: 'set' },
        { path: 'list', verb: 'merge' },
        { path: 'fresh', verb: 'set' },
      ],
    };
  };

  it('applySmartMerge (public): byte-identical to 9.28.0 — aliasing included — and shares nothing with its inputs', () => {
    const ours = nested();
    const theirs = nested();
    const out = applySmartMerge(ours.base, ours.updates, ours.overwrite, ours.trace);
    const old = baselineApplySmartMerge(theirs.base, theirs.updates, theirs.overwrite, theirs.trace);
    expect(out).toEqual(old);
    expect(out.a === out.b).toBe(old.a === old.b);
    const inputs = new Set<object>();
    for (const v of [ours.base, ours.updates, ours.overwrite]) containersOf(v, inputs);
    for (const c of containersOf(out)) expect(inputs.has(c)).toBe(false);
    expect(ours.base.a).toEqual({ v: 0 });
  });
});
