/**
 * Unit tests for reactive/jsonProjection -- the view a proxied value hands to
 * JSON.stringify.
 *
 * Two laws:
 *   1. Acyclic input comes back BY REFERENCE (borrowed, never cloned).
 *   2. Only a back-edge to an ancestor is pruned; a diamond is not a cycle.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toJSONView } from '../../../../src/lib/reactive/jsonProjection';

describe('toJSONView -- unit: acyclic values are borrowed', () => {
  it('returns the same reference for a flat object', () => {
    const raw = { a: 1, b: 'two' };
    expect(toJSONView(raw)).toBe(raw);
  });

  it('returns the same reference for deeply nested objects and arrays', () => {
    const raw = { a: { b: { c: [1, { d: 2 }] } } };
    expect(toJSONView(raw)).toBe(raw);
  });

  it('returns the same reference when members are Dates, Maps or class instances', () => {
    class Widget {
      constructor(public id: number) {}
    }
    const raw = { when: new Date(), m: new Map(), w: new Widget(1), re: /x/ };
    expect(toJSONView(raw)).toBe(raw);
  });

  it('a diamond is not a cycle -- the shared object is kept on both paths', () => {
    const shared = { v: 1 };
    const raw = { left: shared, right: shared };
    expect(toJSONView(raw)).toBe(raw);
    expect(JSON.parse(JSON.stringify(toJSONView(raw)))).toEqual({ left: { v: 1 }, right: { v: 1 } });
  });

  it('null-prototype objects are walked like plain objects', () => {
    const child = Object.create(null) as Record<string, unknown>;
    child.n = 1;
    const raw = { child };
    expect(toJSONView(raw)).toBe(raw);
  });

  it('frozen members are walked too (a frozen object can sit on a cycle)', () => {
    const cyclic: any = { name: 'frozen' };
    cyclic.self = cyclic;
    const raw = { inner: Object.freeze(cyclic) };
    expect(JSON.parse(JSON.stringify(toJSONView(raw)))).toEqual({ inner: { name: 'frozen' } });
  });
});

describe('toJSONView -- boundary: cycles', () => {
  it('prunes a self-reference and keeps the rest', () => {
    const raw: any = { name: 'root', tags: ['a', 'b'] };
    raw.self = raw;
    expect(toJSONView(raw)).toEqual({ name: 'root', tags: ['a', 'b'] });
    expect(() => JSON.stringify(toJSONView(raw))).not.toThrow();
  });

  it('prunes a two-hop cycle at the back-edge only', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;
    expect(toJSONView(alice)).toEqual({ name: 'Alice', friend: { name: 'Bob' } });
  });

  it('a pruned array element keeps its slot so indices still line up', () => {
    const arr: any[] = [{ n: 0 }, null, { n: 2 }];
    arr[1] = arr; // back-edge in the middle
    const view = toJSONView({ arr }) as { arr: unknown[] };
    expect(JSON.parse(JSON.stringify(view))).toEqual({ arr: [{ n: 0 }, null, { n: 2 }] });
  });

  it('copies only along the path to the cycle -- untouched siblings stay borrowed', () => {
    const clean = { untouched: true };
    const dirty: any = { name: 'dirty' };
    dirty.self = dirty;
    const raw = { clean, dirty };

    const view = toJSONView(raw) as Record<string, unknown>;
    expect(view).not.toBe(raw); // the cycle forced a copy at the root
    expect(view.clean).toBe(clean); // ...but the clean branch was NOT cloned
  });

  it('handles an empty object and an empty array', () => {
    const emptyObj = {};
    const emptyArr: unknown[] = [];
    expect(toJSONView(emptyObj)).toBe(emptyObj);
    expect(toJSONView(emptyArr)).toBe(emptyArr);
  });
});

describe('toJSONView -- property: serialization is lossless for acyclic values', () => {
  it('JSON.stringify(view) equals JSON.stringify(raw) for any generated object', () => {
    fc.assert(
      fc.property(fc.object({ maxDepth: 4 }), (raw) => {
        expect(JSON.stringify(toJSONView(raw))).toBe(JSON.stringify(raw));
      }),
      { numRuns: 200 },
    );
  });
});
