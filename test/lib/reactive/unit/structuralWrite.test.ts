/**
 * `setInPath` / `deleteInPath` are the write path's promise that a READ stays
 * untouched. Every deep write the typed scope intercepts builds its next value
 * with them, over a value that may be a bare reference into committed shared
 * memory — which is immutable-after-swap, and whose in-place mutation would
 * corrupt every in-flight stage.
 */
import { describe, expect, it } from 'vitest';

import { deleteInPath, setInPath } from '../../../../src/lib/reactive/structuralWrite';

describe('setInPath', () => {
  it('never mutates the value it was given', () => {
    const root = { a: { b: [{ n: 1 }, { n: 2 }] } };
    const frozenView = JSON.stringify(root);
    const next = setInPath(root, ['a', 'b', '0', 'n'], 99) as typeof root;
    expect(JSON.stringify(root)).toBe(frozenView);
    expect(next.a.b[0].n).toBe(99);
    expect(next.a.b[1].n).toBe(2);
  });

  it('copies only the containers on the path — siblings stay shared', () => {
    const sibling = { untouched: true };
    const root = { a: { b: { n: 1 }, sibling }, other: sibling };
    const next = setInPath(root, ['a', 'b', 'n'], 99) as any;
    expect(next).not.toBe(root);
    expect(next.a).not.toBe(root.a);
    expect(next.a.b).not.toBe(root.a.b);
    // Off the path: same object, no clone paid for.
    expect(next.a.sibling).toBe(sibling);
    expect(next.other).toBe(sibling);
  });

  it('keeps arrays as arrays and writes by index', () => {
    const next = setInPath([1, 2, 3], ['1'], 99) as number[];
    expect(Array.isArray(next)).toBe(true);
    expect(next).toEqual([1, 99, 3]);
  });

  it('an empty path returns the value itself', () => {
    expect(setInPath({ a: 1 }, [], 'replaced')).toBe('replaced');
  });

  it('creates intermediate objects through a missing path', () => {
    expect(setInPath({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
  });

  it('preserves values JSON cannot carry (the buffer clone, not JSON, detaches)', () => {
    const when = new Date('2020-01-01T00:00:00.000Z');
    const next = setInPath({ when, n: 1 }, ['n'], 2) as any;
    expect(next.when).toBe(when);
  });
});

describe('deleteInPath', () => {
  it('removes an object key from a copy', () => {
    const root = { a: { b: 1, c: 2 } };
    const next = deleteInPath(root, ['a', 'b']) as any;
    expect(root.a).toEqual({ b: 1, c: 2 });
    expect(next.a).toEqual({ c: 2 });
  });

  it('removes an array slot by splicing — never leaving a hole', () => {
    const next = deleteInPath({ a: [1, 2, 3] }, ['a', '1']) as any;
    expect(next.a).toEqual([1, 3]);
    expect(next.a.length).toBe(2);
  });

  it('a path that does not exist returns the root unchanged, by reference', () => {
    const root = { a: { b: 1 } };
    expect(deleteInPath(root, ['a', 'nope'])).toBe(root);
    expect(deleteInPath(root, ['missing', 'deep'])).toBe(root);
  });
});

describe('a `__proto__` segment is an own key', () => {
  it('setInPath defines an own key and leaves the prototype alone', () => {
    const next = setInPath({ a: 1 }, ['__proto__'], { evil: 1 }) as any;
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(next.evil).toBeUndefined();
  });

  it('setInPath never walks into an inherited value', () => {
    const next = setInPath({}, ['__proto__', 'x'], 1) as any;
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(JSON.stringify(next)).toBe('{"__proto__":{"x":1}}');
    expect((Object.prototype as any).x).toBeUndefined();
  });

  it('deleteInPath rebuilds below an own `__proto__` key as an own key', () => {
    const root = JSON.parse('{"__proto__":{"x":1,"y":2}}');
    const next = deleteInPath(root, ['__proto__', 'x']) as any;
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(JSON.stringify(next)).toBe('{"__proto__":{"y":2}}');
  });
});
