/**
 * capture/freeze.ts — the ONE deep-freeze walk (F3, 9.33.0). Its callers: run args (`createFrozenArgs`), the
 * served fold base, the dev-mode snapshot and every commit bundle (`EventLog · record`).
 *
 *   unit      the walk freezes every object reachable through own properties, arrays included, and returns
 *             its argument; functions are not descended
 *   boundary  an ALREADY-frozen object is still descended, once: a shallow-frozen input comes out deep-frozen;
 *             a cycle and a repeated reference terminate; a fresh tree never creates the WeakSet that does it
 *   edge      ArrayBuffer views are skipped (a non-empty typed array cannot be frozen — it used to throw);
 *             the holes `Object.freeze` cannot close (Map/Set contents, a Date's time) stay open; a frozen
 *             RegExp's `lastIndex` is read-only; `'indices'` walks arrays by index, so an object on an array
 *             expando is left unfrozen there — and ONLY there: the default walk still reaches it
 */
import { deepFreeze } from '../../../src/lib/capture/freeze';
import { createFrozenArgs } from '../../../src/lib/scope/protection/readonlyInput';

describe('deepFreeze — the walk', () => {
  it('freezes every object reachable through own properties and returns its argument', () => {
    const tree = { a: { b: [{ c: 1 }, [2, { d: 3 }]] }, e: 'x' };
    expect(deepFreeze(tree)).toBe(tree);
    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree.a)).toBe(true);
    expect(Object.isFrozen(tree.a.b)).toBe(true);
    expect(Object.isFrozen(tree.a.b[0])).toBe(true);
    expect(Object.isFrozen(tree.a.b[1])).toBe(true);
    expect(Object.isFrozen((tree.a.b[1] as unknown[])[1])).toBe(true);
  });

  it('leaves primitives and functions alone', () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
    const fn = () => 1;
    const holder = deepFreeze({ fn });
    expect(Object.isFrozen(holder)).toBe(true);
    expect(Object.isFrozen(fn)).toBe(false);
  });
});

describe('deepFreeze — an already-frozen object is still descended, once', () => {
  it('a shallow-frozen input comes out deep-frozen', () => {
    const inner = { x: 1, deeper: { y: 2 } };
    const input = Object.freeze({ inner });
    deepFreeze(input);
    expect(Object.isFrozen(inner)).toBe(true);
    expect(Object.isFrozen(inner.deeper)).toBe(true);
  });

  it('a frozen array holding unfrozen objects: the objects are frozen', () => {
    const element = { n: 1 };
    deepFreeze({ list: Object.freeze([element]) });
    expect(Object.isFrozen(element)).toBe(true);
  });

  it('a cycle terminates, and every node of it ends frozen', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    a.self = a;
    deepFreeze(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('a cycle through an already-frozen object terminates too', () => {
    const child: Record<string, unknown> = { v: 1 };
    const parent = Object.freeze({ child });
    child.parent = parent;
    deepFreeze(parent);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it('a repeated reference is frozen once and terminates', () => {
    const shared = { v: { w: 1 } };
    deepFreeze({ left: shared, right: [shared, shared] });
    expect(Object.isFrozen(shared.v)).toBe(true);
  });

  it('a FRESH tree never creates the WeakSet — a frozen list of names does not either', () => {
    const RealWeakSet = globalThis.WeakSet;
    let created = 0;
    class CountingWeakSet<T extends object> extends RealWeakSet<T> {
      constructor() {
        super();
        created++;
      }
    }
    globalThis.WeakSet = CountingWeakSet as unknown as WeakSetConstructor;
    try {
      deepFreeze({ a: [{ b: 1 }, { c: [2, 3] }], tags: Object.freeze(['x', 'y']) }, 'indices');
      deepFreeze({ a: [{ b: 1 }] });
      expect(created).toBe(0);
      deepFreeze({ inner: Object.freeze({ deeper: {} }) }); // a frozen object WITH an object below it
      expect(created).toBe(1);
    } finally {
      globalThis.WeakSet = RealWeakSet;
    }
  });
});

describe('deepFreeze — edges and named holes', () => {
  it('skips ArrayBuffer views: a non-empty typed array no longer throws, and is left unfrozen', () => {
    expect(() => Object.freeze(new Uint8Array(2))).toThrow(TypeError); // why it is skipped
    const bytes = new Uint8Array([1, 2]);
    const view = new DataView(new ArrayBuffer(4));
    const tree = deepFreeze({ bytes, view, nested: { more: new Float64Array(3) } });
    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree.nested)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(false);
    bytes[0] = 9; // the named hole: buffer bytes stay writable
    expect(bytes[0]).toBe(9);
    expect(Object.isFrozen(view)).toBe(false);
  });

  it('Map and Set contents and a Date’s time stay mutable — Object.freeze cannot reach internal slots', () => {
    const map = new Map([['k', { v: 1 }]]);
    const set = new Set([1]);
    const date = new Date(0);
    deepFreeze({ map, set, date });
    expect(Object.isFrozen(map) && Object.isFrozen(set) && Object.isFrozen(date)).toBe(true);
    map.set('k2', { v: 2 });
    set.add(2);
    date.setTime(5);
    expect([map.size, set.size, date.getTime()]).toEqual([2, 2, 5]);
  });

  it('a frozen RegExp’s lastIndex is read-only: a /g regex taken from a frozen tree throws when replace advances it', () => {
    const tree = deepFreeze({ re: /a/g });
    expect(() => 'aa'.replace(tree.re, 'b')).toThrow(TypeError);
    expect('aa'.replace(new RegExp(tree.re), 'b')).toBe('bb'); // a copy is the way to use it
  });

  it("'indices' leaves an object on an array EXPANDO unfrozen; the default walk freezes it", () => {
    const note = { text: 'hi' };
    const list = Object.assign([{ a: 1 }], { note });
    deepFreeze({ list }, 'indices');
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(Object.isFrozen(note)).toBe(false); // the record's named hole

    const note2 = { text: 'hi' };
    deepFreeze({ list: Object.assign([{ a: 1 }], { note: note2 }) });
    expect(Object.isFrozen(note2)).toBe(true); // args and the dev-mode snapshot keep it
  });

  it('createFrozenArgs keeps its contract and gains the stronger walk: a shallow-frozen argument is frozen all the way down', () => {
    const order = Object.freeze({ lines: [{ sku: 'A' }] });
    const args = createFrozenArgs({ order, bytes: new Uint8Array([1]) }) as { order: typeof order };
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args.order.lines)).toBe(true);
    expect(Object.isFrozen(args.order.lines[0])).toBe(true);
  });
});
