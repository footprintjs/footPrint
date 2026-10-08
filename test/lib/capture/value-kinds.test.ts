/**
 * capture/valueKinds.ts — what KIND of value a record holds: the one classifier (9.45.0). Generated from
 * the RUNTIME, so a kind the table has never heard of is still checked:
 *
 *   completeness  every global constructor of this runtime whose instance `structuredClone` keeps lands on
 *                 the kind its clone is (read off the clone's own tag, not the library), and every one of
 *                 them compares equal to its own clone — unless its content is opaque, which is equal only
 *                 to itself
 *   honesty       `SEALABLE` is true EXACTLY where `Object.freeze` seals: on a frozen sample of each kind,
 *                 every mutation a holder can try (test/helpers/valueKinds.ts · vandalize) moves nothing
 *                 for a sealable kind and something for every other kind — but `opaque`, which is never
 *                 ASSUMED sealed
 *   unit          a class instance, a subclass of a built-in, Node's Buffer, a value from another realm,
 *                 a value the clone refuses
 */
import vm from 'node:vm';

import { type ValueKind, kindOf, SEALABLE } from '../../../src/lib/capture/valueKinds';
import { deepEqual } from '../../../src/lib/memory/equality';
import { Point, recordKey, vandalize } from '../../helpers/valueKinds';

/** The kind a CLONE is, from its own tag — independent of the classifier under test. */
function kindOfClone(clone: object): ValueKind {
  if (Array.isArray(clone)) return 'array';
  const proto = Object.getPrototypeOf(clone);
  if (proto === Object.prototype || proto === null) return 'plain';
  const tag = Object.prototype.toString.call(clone).slice(8, -1);
  if (tag === 'Date' || tag === 'RegExp' || tag === 'Map' || tag === 'Set') return tag.toLowerCase() as ValueKind;
  if (tag === 'Error') return 'error';
  if (['Number', 'String', 'Boolean', 'BigInt'].includes(tag)) return 'boxed';
  if (tag === 'ArrayBuffer' || tag === 'SharedArrayBuffer') return 'buffer';
  if (ArrayBuffer.isView(clone)) return 'view';
  return 'opaque';
}

/**
 * Constructors left out: a no-argument instance has side effects (a port, a socket, a thread), or the
 * constructor is deprecated and warns (`Buffer` — its kind is pinned by the unit test below).
 */
const SIDE_EFFECTS = new Set([
  'MessageChannel',
  'BroadcastChannel',
  'Worker',
  'WebSocket',
  'EventSource',
  'SharedWorker',
  'Buffer',
]);

function cloneableGlobals(): Array<{ name: string; instance: object; clone: object }> {
  const out: Array<{ name: string; instance: object; clone: object }> = [];
  for (const name of Object.getOwnPropertyNames(globalThis).sort()) {
    if (!/^[A-Z]/.test(name) || SIDE_EFFECTS.has(name)) continue;
    const ctor = (globalThis as Record<string, unknown>)[name];
    if (typeof ctor !== 'function') continue;
    let instance: unknown;
    let clone: unknown;
    try {
      instance = Reflect.construct(ctor, []);
      clone = structuredClone(instance);
    } catch {
      continue; // needs arguments, or a value no record can hold
    }
    if (instance !== null && typeof instance === 'object') out.push({ name, instance, clone: clone as object });
  }
  return out;
}

describe('valueKinds — completeness, over every cloneable global of this runtime', () => {
  const globals = cloneableGlobals();

  it('finds the built-ins and the host objects (the walk is not vacuous)', () => {
    const names = globals.map((g) => g.name);
    for (const name of ['Date', 'Map', 'Set', 'RegExp', 'Error', 'TypeError', 'ArrayBuffer', 'Uint8Array', 'Blob']) {
      expect(names).toContain(name);
    }
  });

  it.each(globals.map((g) => [g.name, g] as const))('%s lands on the kind its clone is', (_name, g) => {
    expect(kindOf(g.instance)).toBe(kindOfClone(g.clone));
  });

  it.each(globals.map((g) => [g.name, g] as const))(
    '%s equals its own clone (unless its content is opaque)',
    (_n, g) => {
      expect(deepEqual(g.instance, g.clone)).toBe(kindOf(g.instance) !== 'opaque');
      expect(deepEqual(g.instance, g.instance)).toBe(true);
    },
  );
});

/** One fresh sample per kind, its content its own (a container's children are other values). */
const SAMPLES: Record<ValueKind, Array<() => object>> = {
  plain: [() => ({ a: 1 })],
  array: [() => [1, 2]],
  boxed: [() => Object(1), () => Object('ab'), () => Object(true), () => Object(1n)],
  date: [() => new Date(5)],
  regexp: [() => /a/g],
  map: [() => new Map([['k', 1]])],
  set: [() => new Set([1])],
  error: [() => new Error('e'), () => new TypeError('t')],
  buffer: [
    () => new Uint8Array([1, 2, 3]).buffer,
    () => new (ArrayBuffer as unknown as new (n: number, o: object) => ArrayBuffer)(3, { maxByteLength: 8 }),
  ],
  view: [() => new Uint8Array([1, 2, 3]), () => new Float64Array([1]), () => new DataView(new ArrayBuffer(4))],
  // A Blob is opaque on every runtime. (A DOMException's clone differs by runtime — itself on Node 24
  // and in browsers, a plain `{}` on Node 22 — and the classifier follows the clone, so it is not a sample.)
  opaque: [() => new Blob(['a'])],
};

/** Did anything a holder can do move the value's content (as a record holds it)? */
function movedByHolder(value: object): boolean {
  let frozen = true;
  try {
    Object.freeze(value);
  } catch {
    frozen = false; // a non-empty typed array: freezing refuses it outright
  }
  const before = recordKey(value, 'kind');
  vandalize(value);
  let after: string;
  try {
    after = recordKey(value, 'kind');
  } catch {
    after = '<unreadable>'; // a buffer transfer() detached
  }
  return !frozen || before !== after;
}

describe('valueKinds — SEALABLE is honest both ways', () => {
  it('every kind has samples', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(SEALABLE).sort());
  });

  it.each(Object.entries(SAMPLES).flatMap(([kind, makers]) => makers.map((make) => [kind, make] as const)))(
    '%s: Object.freeze seals it exactly when SEALABLE says so',
    (kind, make) => {
      const sample = make();
      expect(kindOf(sample)).toBe(kind);
      if (kind === 'opaque') {
        expect(SEALABLE.opaque).toBe(false); // content this library cannot read is never assumed sealed
        return;
      }
      expect(movedByHolder(sample)).toBe(!SEALABLE[kind as ValueKind]);
    },
  );
});

describe('valueKinds — kindOf, by what the clone is', () => {
  it('a class instance is plain; a subclass of a built-in is the built-in; Buffer is a view', () => {
    class Stamp extends Date {}
    class Registry extends Map<string, number> {}
    expect(kindOf(new Point(1))).toBe('plain');
    expect(kindOf(new Stamp(0))).toBe('date');
    expect(kindOf(new Registry())).toBe('map');
    expect(kindOf(Buffer.from('ab'))).toBe('view');
    expect(kindOf(Object.create(null))).toBe('plain');
  });

  it('a value from another realm lands on its kind — and still compares by content', () => {
    const date = vm.runInNewContext('new Date(5)') as Date;
    const regex = vm.runInNewContext('/a/g') as RegExp;
    expect(kindOf(date)).toBe('date');
    expect(kindOf(regex)).toBe('regexp');
    expect(deepEqual(date, new Date(5))).toBe(true);
    expect(deepEqual(date, new Date(6))).toBe(false);
  });

  it('a value the clone refuses is opaque: equal only to itself', () => {
    const live = { run: () => 1 };
    class Service {
      call = () => 1;
    }
    expect(kindOf(new Service())).toBe('opaque');
    expect(kindOf(live)).toBe('plain'); // a plain object is plain whatever it holds; its commit refuses it
    const s = new Service();
    expect(deepEqual(s, s)).toBe(true);
    expect(deepEqual(s, new Service())).toBe(false);
  });
});
