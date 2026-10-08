/**
 * capture/freeze.ts — the ONE deep-freeze walk (F3, 9.33.0). Its callers: run args (`createFrozenArgs`), the
 * served fold base, the dev-mode snapshot and every commit bundle (`EventLog · record`).
 *
 *   unit      the walk freezes every object reachable through own properties, arrays included, and returns
 *             its argument; functions are not descended
 *   boundary  an ALREADY-frozen object is left as it is and not walked past (9.32.0's contract — a caller's
 *             frozen argument may hold live parts a stage calls); a cycle and a repeated reference terminate
 *   edge      ArrayBuffer views are skipped (a non-empty typed array cannot be frozen — it used to throw);
 *             the holes `Object.freeze` cannot close (Map/Set contents, a Date's time) stay open; a frozen
 *             RegExp's `lastIndex` is read-only; `'indices'` walks arrays by index, so an object on an array
 *             expando is left unfrozen there — and ONLY there: the default walk still reaches it
 */
import { flowChart, FlowChartExecutor } from '../../../src';
import { deepFreeze, freezeRecord, serveRecord } from '../../../src/lib/capture/freeze';
import { createFrozenArgs } from '../../../src/lib/scope/protection/readonlyInput';

/** Is `record` served as a copy — does it hold a value freezing cannot seal? */
const holdsUnsealed = (record: object) => serveRecord(record) !== record;

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

describe("deepFreeze — an already-frozen object is left as it is (9.32.0's contract)", () => {
  it('a shallow-frozen input is not walked past: its children stay as the caller made them', () => {
    const inner = { x: 1, deeper: { y: 2 } };
    const input = Object.freeze({ inner });
    deepFreeze({ input });
    expect(Object.isFrozen(inner)).toBe(false);
    expect(Object.isFrozen(inner.deeper)).toBe(false);
  });

  it('regression: a class instance inside a frozen argument stays callable — and the caller’s object is not frozen', async () => {
    class Counter {
      n = 0;
      bump() {
        this.n++;
      }
    }
    const svc = new Counter();
    const chart = flowChart(
      'A',
      (s: any) => {
        svc.bump();
        s.x = 1;
      },
      'a',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { cfg: Object.freeze({ svc }) } });
    expect(svc.n).toBe(1);
    expect(Object.isFrozen(svc)).toBe(false);
    svc.bump(); // after the run, the caller's object is still the caller's
    expect(svc.n).toBe(2);
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

  it('a repeated reference is frozen once', () => {
    const shared = { v: { w: 1 } };
    deepFreeze({ left: shared, right: [shared, shared] });
    expect(Object.isFrozen(shared.v)).toBe(true);
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

  it('createFrozenArgs keeps its 9.32.0 contract: a shallow-frozen argument is not walked past; a typed array is skipped', () => {
    const lines = [{ sku: 'A' }];
    const order = Object.freeze({ lines });
    const args = createFrozenArgs({ order, plain: { n: 1 }, bytes: new Uint8Array([1]) }) as {
      order: typeof order;
      plain: { n: number };
    };
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args.plain)).toBe(true);
    expect(Object.isFrozen(lines)).toBe(false);
  });
});

describe('freezeRecord / serveRecord — freeze what can be frozen, copy what can’t (9.44.2)', () => {
  it('a record freezing seals whole is served as itself', () => {
    const record = freezeRecord({ a: { b: [1, 'x', null] }, n: Object(1) });
    expect(holdsUnsealed(record)).toBe(false);
    expect(serveRecord(record)).toBe(record);
  });

  it('a record holding a value freezing cannot seal is served as a fresh frozen copy, every time', () => {
    const record = freezeRecord({ nested: { when: new Date(5) } }, 'indices');
    expect(holdsUnsealed(record)).toBe(true);
    const served = serveRecord(record);
    expect(served).not.toBe(record);
    expect(Object.isFrozen(served.nested)).toBe(true);
    served.nested.when.setTime(0); // the reader's own copy
    expect(record.nested.when.getTime()).toBe(5);
    // a copy is a record too: one stored from an earlier serve is copied again
    expect(serveRecord(served)).not.toBe(served);
  });

  it('every kind freezing cannot seal marks the record — a view, a buffer, a Map, a Set, a RegExp, an error, a Blob', () => {
    for (const value of [
      new Uint8Array([1]),
      new ArrayBuffer(1),
      new Map(),
      new Set(),
      /a/,
      new Error('e'),
      new Blob(['a']),
    ]) {
      expect(holdsUnsealed(freezeRecord({ deep: [{ value }] }))).toBe(true);
    }
  });

  it('a part frozen before is not frozen past, but is looked through: a Date inside it still marks the record', () => {
    const inner = Object.freeze({ when: new Date(5) }); // a hand-built bundle's pre-frozen part
    const record = freezeRecord({ p: inner }, 'indices');
    expect(holdsUnsealed(record)).toBe(true);
    serveRecord(record).p.when.setTime(0); // the reader's copy
    expect(inner.when.getTime()).toBe(5);
    expect(holdsUnsealed(freezeRecord({ p: Object.freeze({ n: 1 }) }))).toBe(false);
  });

  it("'indices' does not see an array expando — the named hole, out of contract for state", () => {
    const record = freezeRecord({ list: Object.assign([1], { when: new Date(5) }) }, 'indices');
    expect(holdsUnsealed(record)).toBe(false);
    expect(holdsUnsealed(freezeRecord({ list: Object.assign([1], { when: new Date(5) }) }))).toBe(true);
  });
});

describe('freezeRecord / serveRecord — the open paths, iteratively (9.44.2)', () => {
  /** A chain `depth` objects deep, `leaf` at the bottom. */
  const chain = (depth: number, leaf: unknown) => {
    let node: Record<string, unknown> = { leaf };
    for (let i = 0; i < depth; i++) node = { next: node };
    return node;
  };
  const bottom = (node: Record<string, unknown>) => {
    let at = node;
    while (at.next !== undefined) at = at.next as Record<string, unknown>;
    return at;
  };

  it('a record 20,000 deep freezes, is looked through and is served without a recursion', () => {
    // Identity is compared as booleans: the matcher's own deep diff would recurse 20,000 levels.
    const sealed = freezeRecord(chain(20_000, 1));
    expect(holdsUnsealed(sealed)).toBe(false);
    expect(serveRecord(sealed) === sealed).toBe(true);
    expect(Object.isFrozen(bottom(sealed))).toBe(true);

    const open = freezeRecord(chain(20_000, new Date(5)));
    expect(holdsUnsealed(open)).toBe(true);
    const served = serveRecord(open);
    expect(served === open).toBe(false);
    (bottom(served).leaf as Date).setTime(0); // the reader's copy, 20,000 down
    expect((bottom(open).leaf as Date).getTime()).toBe(5);
    expect((bottom(serveRecord(open)).leaf as Date).getTime()).toBe(5);

    expect(() => deepFreeze(chain(20_000, { x: 1 }))).not.toThrow();
  });

  it('only the open paths are copied: a sealed part is served as itself, shared', () => {
    const history = Array.from({ length: 1_000 }, (_, i) => ({ i, text: `m${i}` }));
    const record = freezeRecord({ history, meta: { at: new Date(1), tags: ['a'] } });
    const served = serveRecord(record);
    expect(served).not.toBe(record);
    expect(served.history).toBe(record.history); // sealed: shared, not copied
    expect(served.meta).not.toBe(record.meta); // on the way to the Date: copied
    expect(served.meta.tags).toBe(record.meta.tags);
    expect(served.meta.at).not.toBe(record.meta.at);
  });

  it('a part another record already mapped still opens the new record on the way to it', () => {
    const shared = { when: new Date(5) };
    serveRecord(freezeRecord({ shared })); // maps `shared` as an open path of the first record
    const second = freezeRecord({ wrap: { shared } });
    const served = serveRecord(second);
    expect(served.wrap.shared === shared).toBe(false);
    served.wrap.shared.when.setTime(0); // the reader's copy
    expect(shared.when.getTime()).toBe(5);
    expect(serveRecord(second).wrap.shared.when.getTime()).toBe(5);
  });

  it('sharing and cycles inside a record are kept in its served copy', () => {
    const when = new Date(3);
    const node: Record<string, unknown> = { a: when, b: when };
    node.self = node;
    const served = serveRecord(freezeRecord({ node })) as { node: Record<string, unknown> };
    expect(served.node.a).toBe(served.node.b); // one Date, copied once
    expect(served.node.self).toBe(served.node); // the cycle lands on the copy
    expect(served.node.a).not.toBe(when);
  });

  it('a view over a SLICE of a bigger buffer (a Node Buffer and its pool) keeps only the bytes it views', () => {
    const pooled = Buffer.from('hi'); // a slice of Node's shared pool
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength);
    const record = freezeRecord({
      bytes: structuredClone(pooled),
      view: new DataView(new Uint8Array([9, 1, 2]).buffer, 1),
    });
    const bytes = record.bytes as Uint8Array;
    expect([...bytes]).toEqual([...pooled]);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength); // the pool's other bytes are gone from the record
    expect(new Uint8Array((record.view as DataView).buffer)).toEqual(new Uint8Array([1, 2]));
  });
});
