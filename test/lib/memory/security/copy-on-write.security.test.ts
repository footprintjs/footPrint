/**
 * Copy-on-write commit (9.29.0) — security.
 *
 * The path copier walks paths taken from commit bundles (`trace[].path`) and
 * from stage reads; a bundle can come from outside (an imported recording, a
 * resumed checkpoint's log). It must refuse the three prototype-pollution
 * segments exactly where `nativeSet` / `nativeGet` refuse them, never invoke
 * the `__proto__` setter while copying, and never hand a served view a
 * container of the record (an edit of the view would edit the evidence).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMergeInto, DELIM, nextGeneration } from '../../../../src/lib/memory/utils';
import { stateAt } from '../../../../src/trace.js';

const HOSTILE: string[][] = [
  ['__proto__', 'polluted'],
  ['constructor', 'prototype', 'polluted'],
  ['a', '__proto__', 'polluted'],
  ['a', 'constructor', 'prototype', 'polluted'],
  ['prototype', 'polluted'],
];

const clean = () => {
  expect(({} as any).polluted).toBeUndefined();
  expect((Object.prototype as any).polluted).toBeUndefined();
};

describe('copy-on-write — hostile paths are refused by every replay', () => {
  for (const segs of HOSTILE) {
    const path = segs.join(DELIM);
    for (const verb of ['set', 'merge', 'append', 'delete'] as const) {
      it(`${verb} ${segs.join('.')}: no pollution, base untouched (live commit, fold, SharedMemory)`, () => {
        const overwrite: any = {};
        const updates: any = {};
        const trace: TraceEntry[] = [{ path, verb }];
        // The payload is placed with defineProperty so the hostile key is a
        // real own key of the bundle, as JSON.parse would make it.
        let o = overwrite;
        let u = updates;
        for (const s of segs.slice(0, -1)) {
          Object.defineProperty(o, s, { value: {}, enumerable: true, writable: true, configurable: true });
          Object.defineProperty(u, s, { value: {}, enumerable: true, writable: true, configurable: true });
          o = o[s];
          u = u[s];
        }
        o[segs[segs.length - 1]] = { yes: 1 };
        u[segs[segs.length - 1]] = { yes: 1 };

        const base = Object.freeze({ a: Object.freeze({ k: 1 }) });
        const next = nextGeneration(base, updates, overwrite, trace);
        expect(next).toEqual({ a: { k: 1 } });
        const fold = applySmartMergeInto(structuredClone(base), updates, overwrite, trace);
        expect(fold).toEqual({ a: { k: 1 } });
        const mem = new SharedMemory(undefined, { a: { k: 1 } });
        mem.applyPatch(overwrite, updates, trace);
        expect(mem.getState()).toEqual({ a: { k: 1 } });
        clean();
      });
    }
  }

  it('a private read through a hostile path returns nothing and copies nothing', () => {
    const base = Object.freeze({ a: Object.freeze({ k: 1 }) });
    const buf = new TransactionBuffer(base);
    buf.set(['x'], 1);
    for (const segs of HOSTILE) expect(buf.get(segs)).toBeUndefined();
    expect(buf.peek(['a'])).toBe(base.a);
    clean();
  });

  it('an own `__proto__` DATA key survives a path copy as a key — the prototype setter is never invoked', () => {
    const initial = JSON.parse('{"obj":{"__proto__":{"evil":1},"k":1}}');
    const mem = new SharedMemory(undefined, initial);
    mem.applyPatch({ obj: { k: 2 } }, {}, [{ path: ['obj', 'k'].join(DELIM), verb: 'set' }]);
    const obj = mem.getState().obj as Record<string, unknown>;
    expect(obj.k).toBe(2);
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(obj, '__proto__')).toBe(true);
    expect((obj as any).evil).toBeUndefined();
    clean();
  });
});

describe('copy-on-write — a served view never reaches into the record', () => {
  it.each(['full', 'delta'] as const)(
    'editing live state, the mirror or a fold in place leaves the commit log as recorded (%s)',
    async (commitValues) => {
      const chart = flowChart<any>(
        'S0',
        (s) => {
          s.list = [{ n: 0 }];
          s.profile = { tier: 'gold', tags: ['a'] };
        },
        's0',
      )
        .addFunction('S1', (s) => s.$update('list', [{ n: 1 }]), 's1')
        .addFunction('S2', (s) => s.$update('profile', { tags: ['b'] }), 's2')
        .build();
      const ex = new FlowChartExecutor(chart, { commitValues });
      ex.setRedactionPolicy({ keys: ['unrelatedSecret'] });
      await ex.run();
      const recorded = JSON.stringify(ex.getSnapshot().commitLog);
      const views = [ex.getSnapshot().sharedState, ex.getSnapshot({ redact: true }).sharedState] as any[];
      for (const view of views) {
        view.list[1].n = 666;
        view.profile.tags.push('evil');
      }
      expect(JSON.stringify(ex.getSnapshot().commitLog)).toBe(recorded);
      const fold = stateAt(ex.getSnapshot(), ex.getSnapshot().commitLog.length - 1).state as any;
      expect(fold.list).toEqual([{ n: 0 }, { n: 1 }]);
    },
  );
});
