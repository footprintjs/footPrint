/**
 * Copy-on-write commit (9.29.0) — the primitives, one by one
 * (docs/design/2026-10-copy-on-write-commit.md).
 *
 *   pathOps   — shallowCopy / ownSpine / ownedRootOf / adopt: a path copy
 *               keeps every slot a deep clone kept, and copies only what a
 *               writer did not create.
 *   utils     — the ONE verb switch behind three replays: the public
 *               `applySmartMerge` (a fully detached result — 9.28.0's
 *               contract, byte for byte), the engine's `nextGeneration`
 *               (shares every untouched subtree, never edits its base) and
 *               the folds' `applySmartMergeInto` (the live law below the root).
 *   buffer    — `TransactionBuffer` holds its base by reference; a read after
 *               the first write is the stage's own (private reads, option D);
 *               `peek` is not a read.
 *   memory    — `SharedMemory` detaches its seed once and swaps generations
 *               on every write; `EventLog.materialise` folds by the live law.
 */
import { applySmartMerge as baselineApplySmartMerge } from 'footprintjs-baseline/advanced';
import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog';
import { adopt, ownedRootOf, ownSpine, shallowCopy } from '../../../../src/lib/memory/pathOps';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, applySmartMergeInto, DELIM, nextGeneration } from '../../../../src/lib/memory/utils';
import { containersOf } from '../property/copy-on-write-fixture';

/** Freeze every container of a tree — an edit of any of them then throws. */
function freezeAll<T>(v: T): T {
  for (const c of containersOf(v)) Object.freeze(c);
  return v;
}

/** How many `structuredClone` calls `fn` makes. */
function clonesDuring(fn: () => void): number {
  let n = 0;
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    n++;
    return real(value, options);
  }) as typeof structuredClone;
  try {
    fn();
  } finally {
    globalThis.structuredClone = real;
  }
  return n;
}

describe('pathOps — shallowCopy keeps every slot a deep clone kept', () => {
  it('a plain object: own keys in order, an own `__proto__` key stays a key', () => {
    const src = JSON.parse('{"b":1,"a":{"n":1},"__proto__":{"x":1}}');
    const copy = shallowCopy(src);
    expect(Object.keys(copy)).toEqual(Object.keys(src));
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.a).toBe(src.a); // shallow: children shared
  });

  it('a null-prototype object becomes an ordinary one — what structuredClone made of it', () => {
    const src = Object.assign(Object.create(null), { a: 1 });
    expect(Object.getPrototypeOf(shallowCopy(src))).toBe(Object.getPrototypeOf(structuredClone(src)));
  });

  it('an array: holes, length and a named property a nested write hung on it', () => {
    const src: any = [1, , { n: 3 }]; // eslint-disable-line no-sparse-arrays
    src.note = 'x';
    const copy: any = shallowCopy(src);
    expect(copy.length).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(copy, 1)).toBe(false);
    expect(copy.note).toBe('x');
    expect(copy[2]).toBe(src[2]);
    const big: any = [1];
    big.note = 'n';
    big['4294967295'] = 'not an index'; // past the last array index: a name, in insertion order
    expect(Object.keys(shallowCopy(big))).toEqual(Object.keys(structuredClone(big)));
  });

  it('a Date, Map or Set is cloned with its type — and an expando the clone drops is carried over', () => {
    const when: any = new Date(5);
    when.y = { n: 1 };
    const copy: any = shallowCopy(when);
    expect(copy).toBeInstanceOf(Date);
    expect(copy).not.toBe(when);
    expect(copy.getTime()).toBe(5);
    expect(copy.y).toBe(when.y);
    const m: any = new Map([['k', 1]]);
    m.tag = 't';
    const mc: any = shallowCopy(m);
    expect(mc).toBeInstanceOf(Map);
    expect(mc.get('k')).toBe(1);
    expect(mc.tag).toBe('t');
  });
});

describe('pathOps — ownSpine copies only what the writer did not create', () => {
  it('copies each container on the way to the leaf — never the leaf — and owns the copies', () => {
    const base = freezeAll({ a: { b: { c: 1 }, side: { s: 1 } }, other: { o: 1 } });
    const owned = new WeakSet<object>();
    const root = ownedRootOf(base, owned);
    ownSpine(root, ['a', 'b', 'c'], owned);
    expect(root.a).not.toBe(base.a);
    expect(root.a.b).not.toBe(base.a.b);
    expect(root.a.side).toBe(base.a.side); // a sibling: shared
    expect(root.other).toBe(base.other);
    expect(owned.has(root.a) && owned.has(root.a.b)).toBe(true);
    root.a.b.c = 2; // the write that follows edits only copies
    expect(base.a.b.c).toBe(1);
    const again = root.a.b;
    ownSpine(root, ['a', 'b', 'c'], owned);
    expect(root.a.b).toBe(again); // owned: copied once
  });

  it('a root-key path copies nothing; a missing or primitive intermediate stops the walk', () => {
    const base = { a: 1, b: { c: 1 } };
    const owned = new WeakSet<object>();
    const root = ownedRootOf(base, owned);
    ownSpine(root, ['b'], owned);
    expect(root.b).toBe(base.b);
    ownSpine(root, ['a', 'x', 'y'], owned);
    ownSpine(root, ['missing', 'x'], owned);
    expect(root.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(root, 'missing')).toBe(false);
  });

  it('ownedRootOf: a container is copied shallowly and owned; anything else is what a clone of it is', () => {
    const owned = new WeakSet<object>();
    const base = { k: { n: 1 } };
    const root = ownedRootOf(base, owned);
    expect(root).not.toBe(base);
    expect(root.k).toBe(base.k);
    expect(owned.has(root)).toBe(true);
    expect(ownedRootOf(undefined)).toBeUndefined();
    expect(ownedRootOf(3)).toBe(3);
  });

  it('adopt owns every container of a fresh tree, cycles included', () => {
    const tree: any = { a: [{ b: {} }], c: { d: 1 } };
    tree.self = tree;
    const owned = new WeakSet<object>();
    adopt(tree, owned);
    for (const c of containersOf(tree)) expect(owned.has(c)).toBe(true);
  });
});

describe('utils — one verb switch, three replays', () => {
  const nested = (): { base: any; updates: MemoryPatch; overwrite: MemoryPatch; trace: TraceEntry[] } => {
    const shared = { v: 0 };
    return {
      base: { a: shared, b: shared, list: [{ n: 1 }], keep: { deep: { x: 1 } } },
      updates: { list: [{ n: 2 }] },
      overwrite: { a: { x: 1 }, fresh: { y: [1, 2] } },
      trace: [
        { path: ['a', 'x'].join(DELIM), verb: 'set' },
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
    expect(out.a === out.b).toBe(old.a === old.b); // the clone keeps the alias, and the write lands through it, as before
    const inputs = new Set<object>();
    for (const v of [ours.base, ours.updates, ours.overwrite]) containersOf(v, inputs);
    for (const c of containersOf(out)) expect(inputs.has(c)).toBe(false);
    expect(ours.base.a).toEqual({ v: 0 }); // the base is never edited
  });

  it('applySmartMerge (public): the base clone, then one clone per row — the 9.28.0 cost, unchanged', () => {
    const p = nested();
    expect(clonesDuring(() => applySmartMerge(p.base, {}, { k: 1 }, [{ path: 'k', verb: 'set' }]))).toBe(2);
  });

  it('nextGeneration (engine): untouched subtrees are SHARED, written paths copied, the base never edited', () => {
    const p = nested();
    freezeAll(p.base);
    const next = nextGeneration(p.base, p.updates, p.overwrite, p.trace);
    expect(next).not.toBe(p.base);
    expect(next.keep).toBe(p.base.keep); // untouched: the same object
    expect(next.a).toEqual({ v: 0, x: 1 });
    expect(next.b).toBe(p.base.b); // value semantics: the alias is not written through (M3)
    expect(next.list).toEqual([{ n: 1 }, { n: 2 }]);
    expect(next.list[0]).toBe(p.base.list[0]); // the merge shares the elements it kept
    expect(next.list[1]).not.toBe(p.updates.list[0]); // …and never the log's (D2)
  });

  it('nextGeneration: a bundle of root-key rows copies only the root', () => {
    const base = freezeAll({ history: Array.from({ length: 1000 }, (_, i) => ({ i })), n: 0 });
    let next: any;
    const clones = clonesDuring(() => {
      next = nextGeneration(base, {}, { n: 1 }, [{ path: 'n', verb: 'set' }]);
    });
    expect(clones).toBe(1); // the written value
    expect(next.history).toBe(base.history);
  });

  it('applySmartMergeInto (folds): the root edited in place, the live law below it', () => {
    const p = nested();
    const target = structuredClone(p.base);
    const heldB = target.b;
    const out = applySmartMergeInto(target, p.updates, p.overwrite, p.trace);
    expect(out).toBe(target);
    expect(target.a).toEqual({ v: 0, x: 1 });
    expect(target.b).toBe(heldB);
    expect(heldB).toEqual({ v: 0 }); // the alias is not written through — the fold agrees with nextGeneration
  });
});

describe('TransactionBuffer — the base by reference, reads after the first write private', () => {
  it('construction clones nothing; the diff base is the committed object itself', () => {
    const base = freezeAll({ history: [{ n: 1 }], cfg: { x: 1 } });
    let buf!: TransactionBuffer;
    expect(clonesDuring(() => (buf = new TransactionBuffer(base)))).toBe(0);
    buf.set(['k'], 1); // never edits the frozen base
    expect(buf.commit().trace).toEqual([{ path: 'k', verb: 'set' }]);
  });

  it('a read of a container still shared with committed state returns a private copy — once', () => {
    const base = freezeAll({ cfg: { x: 1, deep: { y: 1 } } });
    const buf = new TransactionBuffer(base);
    buf.set(['other'], 1);
    const first = buf.get(['cfg']);
    expect(first).not.toBe(base.cfg);
    expect(first).toEqual(base.cfg);
    expect(buf.get(['cfg'])).toBe(first);
    first.deep.y = 99; // an in-place edit stays private (the base is frozen — no throw)
    expect(buf.get(['cfg', 'deep', 'y'])).toBe(99);
  });

  it('a value the stage staged is handed back as it is — never a copy of it', () => {
    const base = { cfg: { x: 1 } };
    const buf = new TransactionBuffer(base);
    const mine = { x: 2 };
    buf.set(['cfg'], mine);
    expect(buf.get(['cfg'])).toBe(mine);
    buf.set(['back'], base.cfg); // a committed object staged elsewhere: by reference too
    expect(buf.get(['back'])).toBe(base.cfg);
  });

  it('a namespaced read copies the namespaces on the way shallowly — not every run', () => {
    const base = freezeAll({ runs: { r1: { k: { n: 1 } }, r2: { big: [1, 2, 3] } } });
    const buf = new TransactionBuffer(base);
    buf.set(['g'], 1);
    const k = buf.get(['runs', 'r1', 'k']);
    expect(k).toEqual({ n: 1 });
    expect(k).not.toBe(base.runs.r1.k);
    expect(buf.peek(['runs', 'r2'])).toBe(base.runs.r2); // the sibling run: shared, untouched
  });

  it('reading a container a nested write copied shallowly privatises its shared children', () => {
    const base = freezeAll({ obj: { a: { n: 1 }, b: { n: 2 } } });
    const buf = new TransactionBuffer(base);
    buf.set(['obj', 'c'], 3); // a nested write: obj is copied shallowly
    const obj = buf.get(['obj']);
    expect(obj).toEqual({ a: { n: 1 }, b: { n: 2 }, c: 3 });
    expect(obj.a).not.toBe(base.obj.a);
    expect(obj.b).not.toBe(base.obj.b);
  });

  it('peek reads without taking a copy — a report, not a read', () => {
    const base = { cfg: { x: 1 } };
    const buf = new TransactionBuffer(base);
    buf.set(['other'], 1);
    expect(buf.peek(['cfg'])).toBe(base.cfg);
    expect(clonesDuring(() => buf.peek(['cfg']))).toBe(0);
  });

  it('a merge unions into a PRIVATE base: an element read from committed state is appended, as on 9.28.0', () => {
    const base = { list: [{ n: 1 }] };
    const buf = new TransactionBuffer(base);
    buf.merge(['list'], [base.list[0]]); // the committed element itself
    expect(buf.get(['list'])).toHaveLength(2);
    expect(base.list).toHaveLength(1);
  });

  it('a prototype-pollution segment is refused by a read exactly as nativeGet refuses it', () => {
    const buf = new TransactionBuffer({ a: { b: 1 } });
    buf.set(['x'], 1);
    expect(buf.get(['__proto__'])).toBeUndefined();
    expect(buf.get(['constructor', 'prototype'])).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('SharedMemory — one detached seed, a new generation per write', () => {
  it('the seed is detached once at construction; an empty seed clones nothing', () => {
    const seed = { cfg: { n: 1 } };
    const mem = new SharedMemory(undefined, seed);
    seed.cfg.n = 42;
    expect(mem.getState()).toEqual({ cfg: { n: 1 } });
    expect(clonesDuring(() => new SharedMemory())).toBe(0);
  });

  it('applyPatch, setValue and updateValue swap in a new generation; the old one is never edited', () => {
    const mem = new SharedMemory(undefined, { keep: { k: 1 }, list: [1] });
    const g0 = mem.getState();
    const g0Bytes = JSON.stringify(g0);
    mem.applyPatch({ n: 1 }, {}, [{ path: 'n', verb: 'set' }]);
    const g1 = mem.getState();
    mem.setValue('', ['deep'], 'x', 2);
    mem.updateValue('', [], 'list', [2]);
    const g3 = mem.getState();
    expect(JSON.stringify(g0)).toBe(g0Bytes);
    expect(g1).not.toBe(g0);
    expect(g3).toEqual({ keep: { k: 1 }, list: [1, 2], n: 1, deep: { x: 2 } });
    expect(g3.keep).toBe(g0.keep);
  });
});

describe('EventLog.materialise — one clone per call, the live law per step', () => {
  it('an aliased base and a nested row: the fold agrees with the live commit (value semantics)', () => {
    const o = { v: 0 };
    const mem = new SharedMemory(undefined, { a: o, b: o });
    const log = new EventLog(mem.getState());
    const bundle = {
      overwrite: { a: { x: 1 } },
      updates: {},
      trace: [{ path: ['a', 'x'].join(DELIM), verb: 'set' as const }],
    };
    mem.applyPatch(bundle.overwrite, bundle.updates, bundle.trace);
    log.record({ ...bundle, redactedPaths: [], stage: 'S', stageId: 's', runtimeStageId: 's#0' } as any);
    const folded = log.materialise();
    expect(folded).toEqual(mem.getState());
    expect(folded.b).toEqual({ v: 0 });
    expect(clonesDuring(() => log.materialise())).toBe(2); // the base, then the row's value
  });
});
