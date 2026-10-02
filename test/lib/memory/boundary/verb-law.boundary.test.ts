/**
 * Boundary + cost tests — the verb law at its edges.
 *
 * Empty and out-of-range inputs, a payload that is not there, deep paths — and
 * the COST law the one fold must keep: a reader pays for what the key's rows
 * read, never for the rest of the bundle, and the replay detaches a bundle's
 * merge delta once however many `merge` rows share it. Counted, never timed.
 */
import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, dryFold, nextGeneration } from '../../../../src/lib/memory/utils';
import { foldRows } from '../../../../src/lib/memory/verbs';
import { arrayProvenance } from '../../../../src/lib/slice/elementProvenance';

const bundle = (trace: TraceEntry[], overwrite: MemoryPatch = {}, updates: MemoryPatch = {}, n = 0): CommitBundle => ({
  idx: n,
  stage: `S${n}`,
  stageId: `s${n}`,
  runtimeStageId: `s${n}#${n}`,
  trace,
  redactedPaths: [],
  overwrite,
  updates,
});

/** Every node a `structuredClone` inside `run` is handed. */
function clonedNodes(run: () => unknown): number {
  const count = (v: unknown, seen = new WeakSet<object>()): number => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return 1;
    seen.add(v);
    return 1 + Object.values(v).reduce<number>((n, c) => n + count(c, seen), 0);
  };
  let nodes = 0;
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    nodes += count(value);
    return real(value, options);
  }) as typeof structuredClone;
  try {
    run();
  } finally {
    globalThis.structuredClone = real;
  }
  return nodes;
}

describe('empty and out-of-range', () => {
  it('a bundle with no rows folds to its base under every door', () => {
    const base = { a: { b: 1 } };
    expect(applySmartMerge(base, {}, {}, [])).toEqual(base);
    expect(nextGeneration(base, {}, {}, [])).toEqual(base);
    expect(dryFold(base, {}, {}, [])).toEqual(base);
    for (const discipline of ['private', 'pathCopy', 'byReference'] as const) {
      const out = { a: 1 };
      expect(foldRows(out, {}, {}, [], discipline)).toBe(out);
    }
  });

  it('commitValueAt and arrayProvenance on an empty log, and with idx below or past the log', () => {
    expect(commitValueAt([], 0, 'k')).toBeUndefined();
    expect(arrayProvenance([], 'k')).toEqual({ key: 'k', missing: 'empty-log' });

    const log = [
      bundle([{ path: 'k', verb: 'set' }], { k: [1] }),
      bundle([{ path: 'k', verb: 'append' }], { k: [2] }, {}, 1),
    ];
    expect(commitValueAt(log, -1, 'k')).toBeUndefined();
    expect(commitValueAt(log, 99, 'k')).toEqual([1, 2]); // clamped to the last commit
    expect(arrayProvenance(log, 'k', { atIdx: -1 })).toEqual({ key: 'k', missing: 'never-written' });
    expect(arrayProvenance(log, 'k', { atIdx: 99 }).length).toBe(2);
  });
});

describe('a payload that is not there reads as undefined — it never throws', () => {
  const missing = (verb: TraceEntry['verb']) => applySmartMerge({ a: 1 }, {}, {}, [{ path: 'a', verb }]);

  it('set, merge and append place undefined; delete removes the key', () => {
    for (const verb of ['set', 'merge', 'append'] as const) {
      const out = missing(verb);
      expect(Object.prototype.hasOwnProperty.call(out, 'a')).toBe(true);
      expect(out.a).toBeUndefined();
    }
    expect(missing('delete')).toEqual({});
  });

  it('the per-key readers agree', () => {
    for (const verb of ['set', 'merge', 'append', 'delete'] as const) {
      expect(commitValueAt([bundle([{ path: 'a', verb }])], 0, 'a')).toBeUndefined();
    }
  });
});

describe('depth', () => {
  it('a 60-segment path folds, reads back, and is refused nowhere', () => {
    const segs = Array.from({ length: 60 }, (_, i) => `s${i}`);
    const path = segs.join(DELIM);
    const leaf = { deep: [1, 2, 3] };
    const nested = segs.reduceRight<unknown>((inner, seg) => ({ [seg]: inner }), leaf) as MemoryPatch;
    const log = [bundle([{ path, verb: 'set' }], nested)];
    expect(commitValueAt(log, 0, path)).toEqual(leaf);
    expect(applySmartMerge({}, {}, nested, log[0].trace)).toEqual(nested);
  });
});

describe('COST — a reader pays for what the key reads', () => {
  const big = { rows: Array.from({ length: 300 }, (_, i) => ({ i, text: `row ${i}` })) };
  const updates = { big, k: [{ n: 1 }, { n: 2 }] };
  const trace: TraceEntry[] = [
    { path: 'k', verb: 'set' },
    { path: 'k', verb: 'merge' },
    { path: 'k', verb: 'merge' },
    { path: 'big', verb: 'merge' },
  ];
  const log = [bundle(trace, { k: [] }, updates)];

  it('commitValueAt clones the key’s delta once — not the bundle’s other deltas, not once per merge row', () => {
    const nodes = clonedNodes(() => commitValueAt(log, 0, 'k'));
    expect(nodes).toBeLessThan(20); // the empty seed plus the two-element delta; `big` is ~900 nodes
  });

  it('arrayProvenance pays the same', () => {
    const nodes = clonedNodes(() => arrayProvenance(log, 'k'));
    expect(nodes).toBeLessThan(20);
  });

  it('the replay detaches the bundle’s deltas once, however many merge rows share them', () => {
    const rows = (merges: number): TraceEntry[] =>
      Array.from({ length: merges }, () => ({ path: 'big', verb: 'merge' }));
    const once = clonedNodes(() => applySmartMerge({}, updates, {}, rows(1)));
    const many = clonedNodes(() => applySmartMerge({}, updates, {}, rows(5)));
    expect(many).toBe(once);
  });

  it('a thousand consecutive sets of one path clone the recorded value once', () => {
    const value = { rows: Array.from({ length: 50 }, (_, i) => ({ i })) };
    const one = clonedNodes(() => applySmartMerge({}, {}, { k: value }, [{ path: 'k', verb: 'set' }]));
    const thousand = clonedNodes(() =>
      applySmartMerge(
        {},
        {},
        { k: value },
        Array.from({ length: 1000 }, () => ({ path: 'k', verb: 'set' as const })),
      ),
    );
    expect(thousand).toBe(one);
  });
});
