/**
 * Cyclic values on the commit path (9.18.1).
 *
 * The engine's own law on state values is "must survive `structuredClone`",
 * and `structuredClone` PRESERVES cycles — so a value that references itself
 * (a tool schema whose object pointed at itself, in the field report that
 * found this) is a legal value, and every walker on the commit path must
 * terminate on it. Two did not: `deepEqual` (the net-change filter every
 * commit runs) and `deepSmartMerge` (the `merge` verb, staged and replayed).
 *
 * The record primitives run alone here; deepEqual-cycles.engine.test.ts keeps
 * the real subflow outputMapper, commit-log, fold and cursor witnesses.
 */
import { describe, expect, it } from 'vitest';

import { deepEqual, deepSmartMerge } from '../../../src/lib/memory/utils.js';

interface Schema {
  name: string;
  version: number;
  params: Record<string, unknown>;
  self?: Schema;
}

/** The field shape: an object that references itself one key down. `version`
 *  is set AFTER `self` so a compare walks the cycle before it can find the
 *  one leaf that differs between two versions. */
function cyclicSchema(version = 1): Schema {
  const s = { name: 'search', params: { q: 'string' } } as Schema;
  s.self = s;
  s.version = version;
  return s;
}

// ════════════════════════════════════════════════════════════════════════
// deepEqual — the net-change filter terminates on every legal value
// ════════════════════════════════════════════════════════════════════════

describe('deepEqual — cyclic values', () => {
  it('(a) a self-referential object equals its structural twin', () => {
    expect(deepEqual(cyclicSchema(), cyclicSchema())).toBe(true);
    // The twin the engine itself makes: committed state is a structuredClone.
    const s = cyclicSchema();
    expect(deepEqual(s, structuredClone(s))).toBe(true);
  });

  it('(a) cyclic arrays and two-object (mutual) cycles', () => {
    const a: unknown[] = [1];
    a.push(a);
    const b: unknown[] = [1];
    b.push(b);
    expect(deepEqual(a, b)).toBe(true);

    const p: Record<string, unknown> = { n: 1 };
    const q: Record<string, unknown> = { p };
    p.q = q;
    const p2: Record<string, unknown> = { n: 1 };
    const q2: Record<string, unknown> = { p: p2 };
    p2.q = q2;
    expect(deepEqual(p, p2)).toBe(true);
  });

  it('(b) two cycles of different shape are not equal', () => {
    // Loops back through a node with different data.
    const one: Record<string, unknown> = { name: 'x' };
    one.self = one;
    const two: Record<string, unknown> = { name: 'x' };
    two.self = { name: 'y', self: two };
    expect(deepEqual(one, two)).toBe(false);

    // Loops back under a different key.
    const viaSelf: Record<string, unknown> = { name: 'x' };
    viaSelf.self = viaSelf;
    const viaParent: Record<string, unknown> = { name: 'x' };
    viaParent.parent = viaParent;
    expect(deepEqual(viaSelf, viaParent)).toBe(false);

    // Array cycle vs object cycle.
    const arr: unknown[] = [];
    arr.push(arr);
    const obj: Record<string, unknown> = {};
    obj[0] = obj;
    expect(deepEqual(arr, obj)).toBe(false);
  });

  it('(c) a cycle vs an acyclic value is not equal', () => {
    const s = cyclicSchema();
    const flat = {
      name: 'search',
      version: 1,
      params: { q: 'string' },
      self: { name: 'search', version: 1, params: { q: 'string' } },
    };
    expect(deepEqual(s, flat)).toBe(false);
    expect(deepEqual(flat, s)).toBe(false);
  });

  it('a difference PAST the cycle is still seen — the guard hides no leaf', () => {
    expect(deepEqual(cyclicSchema(1), cyclicSchema(2))).toBe(false);
    const a: Record<string, unknown> = { leaf: { v: 1 } };
    a.self = a;
    const b: Record<string, unknown> = { leaf: { v: 2 } };
    b.self = b;
    expect(deepEqual(a, b)).toBe(false);
  });

  it('(d) acyclic behaviour unchanged — the existing rules, plus shared references', () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ 0: 'a', length: 1 }, ['a'])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    // 9.19.1: an own key holding `undefined` is a DELETED key (absent), so the
    // key-count edge is pinned with HELD values — see utils.test.ts.
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(true);

    // A DAG (one object reachable twice) is not a cycle: each occurrence is
    // compared against its own counterpart.
    const shared = { k: 1 };
    expect(deepEqual({ a: shared, b: shared }, { a: { k: 1 }, b: { k: 1 } })).toBe(true);
    expect(deepEqual({ a: shared, b: shared }, { a: { k: 1 }, b: { k: 2 } })).toBe(false);
    expect(deepEqual({ a: { k: 1 }, b: { k: 2 } }, { a: shared, b: shared })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// deepSmartMerge — the merge verb terminates on a cyclic source
// ════════════════════════════════════════════════════════════════════════

describe('deepSmartMerge — cyclic source', () => {
  it('a cyclic src merges to a value that mirrors the cycle', () => {
    const out = deepSmartMerge({ name: 'old', extra: true }, cyclicSchema());
    expect(out.name).toBe('search');
    expect(out.extra).toBe(true);
    expect(out.params).toEqual({ q: 'string' });
    expect(out.self).toBe(out); // the cycle re-enters the value being built
  });

  it('a shared (acyclic) src reference at two keys still merges against each key’s own dst', () => {
    const shared = { x: 1 };
    const out = deepSmartMerge({ a: { keepA: true }, b: { keepB: true } }, { a: shared, b: shared });
    expect(out.a).toEqual({ keepA: true, x: 1 });
    expect(out.b).toEqual({ keepB: true, x: 1 });
    expect(out.a).not.toBe(out.b);
  });

  it('acyclic behaviour unchanged', () => {
    expect(deepSmartMerge({ a: [1, 2], b: { c: 1 } }, { a: [2, 3], b: { d: 2 }, e: 'x' })).toEqual({
      a: [1, 2, 3],
      b: { c: 1, d: 2 },
      e: 'x',
    });
    expect(deepSmartMerge({ a: [1] }, { a: [] })).toEqual({ a: [] });
    expect(deepSmartMerge({ a: 1 }, null)).toBe(null);
    expect(deepSmartMerge(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });
});
