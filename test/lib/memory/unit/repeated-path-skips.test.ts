/**
 * Unit — the two repeated-path skips (9.22.1).
 *
 * N element writes on one path stage N whole-array `set` rows in ONE bundle.
 * The rows stay (the log is the record); what goes is the clone each row paid
 * twice — once when the commit materialised it, once when every fold replayed
 * it. Both skips obey ONE law: CONSECUTIVE ops on the same path and the same
 * patch tree, nothing in between. This file pins the law's edges — the
 * counterexample that ruled out "once per path", the verbs that never
 * qualify, and the work that is actually skipped (counted, not inferred).
 */
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, DELIM, supersededByNextSet } from '../../../../src/lib/memory/utils';

const rows = (...specs: string[]): TraceEntry[] =>
  specs.map((s) => {
    const [path, verb] = s.split(':');
    return { path: path.replace(/\./g, DELIM), verb: verb as TraceEntry['verb'] };
  });

/** structuredClone calls made while `fn` runs. */
function clonesDuring(fn: () => void): number {
  const spy = vi.spyOn(globalThis, 'structuredClone');
  try {
    fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('supersededByNextSet — the one skip law', () => {
  it('true only for a set whose NEXT row is a set of the same path', () => {
    const t = rows('k:set', 'k:set', 'k:set');
    expect([0, 1, 2].map((i) => supersededByNextSet(t, i))).toEqual([true, true, false]);
  });

  it('a row in between breaks the run — even a merge on the same path', () => {
    expect(supersededByNextSet(rows('k:set', 'k:merge', 'k:set'), 0)).toBe(false);
    expect(supersededByNextSet(rows('k:set', 'other:set', 'k:set'), 0)).toBe(false);
  });

  it('only set → set qualifies: merge, append and delete depend on what is there', () => {
    expect(supersededByNextSet(rows('k:merge', 'k:merge'), 0)).toBe(false);
    expect(supersededByNextSet(rows('k:append', 'k:append'), 0)).toBe(false);
    expect(supersededByNextSet(rows('k:set', 'k:delete'), 0)).toBe(false);
    expect(supersededByNextSet(rows('k:set', 'k:append'), 0)).toBe(false);
    expect(supersededByNextSet(rows('k:set', 'k.sub:set'), 0)).toBe(false);
  });
});

describe('applySmartMerge — N same-path set rows replay with ONE clone of the value', () => {
  it('clones once for the run, not once per row, and lands the last value', () => {
    const trace = Array.from({ length: 1_000 }, () => ({ path: 'k', verb: 'set' as const }));
    const overwrite = { k: Array.from({ length: 50 }, (_, i) => ({ i })) };
    let out: any;
    const clones = clonesDuring(() => {
      out = applySmartMerge({ k: [], z: 1 }, {}, overwrite, trace);
    });
    expect(clones).toBe(2); // the base, then the value — once
    expect(out).toEqual({ k: overwrite.k, z: 1 });
    expect(out.k).not.toBe(overwrite.k); // still a detached copy
  });

  it('a sibling set between two sets of a fresh key keeps the original key order', () => {
    // `set a` (creates a), `set b` (creates b), `set a` (in place) → a before b.
    const out = applySmartMerge({}, {}, { a: 1, b: 2 }, rows('a:set', 'b:set', 'a:set'));
    expect(Object.keys(out)).toEqual(['a', 'b']);
  });
});

describe('TransactionBuffer (full) — N same-path sets commit with ONE clone, N rows', () => {
  it('keeps every trace row and materialises the path once', () => {
    const buf = new TransactionBuffer({ arr: [{ n: 0 }, { n: 0 }] });
    for (let i = 0; i < 500; i++) buf.set(['arr'], [{ n: i }, { n: i + 1 }]);
    let bundle: ReturnType<TransactionBuffer['commit']> | undefined;
    const clones = clonesDuring(() => {
      bundle = buf.commit();
    });
    expect(clones).toBe(1);
    expect(bundle!.trace).toHaveLength(500);
    expect(bundle!.trace.every((t) => t.path === 'arr' && t.verb === 'set')).toBe(true);
    expect(bundle!.overwrite).toEqual({ arr: [{ n: 499 }, { n: 500 }] });
  });

  it('the coercion counterexample: a descendant op between two sets re-copies the ancestor', () => {
    // set list; delete list.1; set list = 0. Materialising `list.1` coerces the
    // primitive 0 into `{}`; the second `set list` is what repairs it — so it
    // must NOT be skipped. ("Once per path" failed exactly here.)
    const buf = new TransactionBuffer({ list: [false, ''] });
    buf.set(['list'], [false, '', false]);
    buf.delete(['list', '1']);
    buf.set(['list'], 0);
    const bundle = buf.commit();
    expect(bundle.overwrite.list).toBe(0);
    expect(bundle.trace.map((t) => t.path)).toEqual(['list', `list${DELIM}1`, 'list']);
    expect(applySmartMerge({ list: [false, ''] }, {}, bundle.overwrite, bundle.trace)).toEqual({ list: 0 });
  });

  it('a descendant op wiped by a later ancestor set leaves no `key: undefined` shell', () => {
    // set k; set k.c; set k ({a}) — the final patch has no `c`, so materialising
    // `k.c` copies `undefined` into a shell the last `set k` must wipe again.
    const buf = new TransactionBuffer({ k: { a: 0 } });
    buf.set(['k'], { a: 1, c: 1 });
    buf.set(['k', 'c'], 2);
    buf.set(['k'], { a: 3 });
    const bundle = buf.commit();
    expect(Object.keys(bundle.overwrite.k as object)).toEqual(['a']);
  });

  it('a merge between two sets does not break the set run (it writes the other tree)', () => {
    const buf = new TransactionBuffer({ k: { a: 0 } });
    buf.set(['k'], { a: 1 });
    buf.merge(['k'], { b: 2 });
    buf.set(['k'], { a: 3, b: 2 });
    let bundle: ReturnType<TransactionBuffer['commit']> | undefined;
    const clones = clonesDuring(() => {
      bundle = buf.commit();
    });
    expect(clones).toBe(2); // one per tree
    expect(bundle!.trace.map((t) => t.verb)).toEqual(['set', 'merge', 'set']);
    expect(bundle!.overwrite).toEqual({ k: { a: 3, b: 2 } });
    expect(bundle!.updates).toEqual({ k: { b: 2 } });
  });

  it('the net-change verdict is decided once per path — a dropped path stays dropped', () => {
    const buf = new TransactionBuffer({ flip: 'x', n: 0 });
    buf.set(['flip'], 'y');
    buf.set(['n'], 1);
    buf.set(['flip'], 'x'); // revert
    const bundle = buf.commit();
    expect(bundle.trace).toEqual([{ path: 'n', verb: 'set' }]);
    expect(bundle.overwrite).toEqual({ n: 1 });
  });
});
