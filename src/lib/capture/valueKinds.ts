/**
 * valueKinds.ts — what KIND of value a record holds: the one classifier.
 *
 * WHY. Committed state is what survives `structuredClone` (an engine invariant), so the values a
 * record holds are the kinds the clone keeps. Two laws need the kind, and both ask here:
 *
 *   - what counts as a CHANGE (`memory/equality.ts · deepEqual`): two values are equal when a record
 *     holds the same thing for both, compared kind by kind. Until 9.45.0 only Date, Map and Set had a
 *     kind; a RegExp, an Error, a boxed number, a buffer, a DataView or a Blob was compared as an
 *     object with no own keys — equal to any other of its kind — so replacing one committed no row
 *     and live state kept the old value;
 *   - what a served record must COPY (`capture/freeze.ts · freezeRecord` / `serveRecord`):
 *     `Object.freeze` seals only the kinds whose content is their own properties ({@link SEALABLE}).
 *
 * A leaf: imports nothing (`capture/` is L0, below `memory/`).
 *
 * @example
 * ```typescript
 * kindOf(new Date(0));                    // 'date'
 * kindOf(new (class Point { x = 1 })());  // 'plain' — its clone is a plain object
 * kindOf(new Blob(['a']));                // 'opaque' — its clone keeps content this library cannot read
 * SEALABLE.date;                          // false — setTime writes a slot Object.freeze cannot reach
 * ```
 */

/** Every kind a record can hold. */
export type ValueKind =
  /** An object the clone keeps as its own enumerable keys — a class instance included. */
  | 'plain'
  | 'array'
  | 'date'
  | 'regexp'
  | 'map'
  | 'set'
  | 'error'
  /** A boxed primitive: `new Number(1)`, `new String('a')`, `new Boolean(true)`, `Object(1n)`. */
  | 'boxed'
  /** An `ArrayBuffer` (a `SharedArrayBuffer` too: shared memory is out of contract for state). */
  | 'buffer'
  /** A typed array or a `DataView`. */
  | 'view'
  /** Any other object the clone keeps as itself (a Blob, a File, a `DOMException`): content unread here. */
  | 'opaque';

/**
 * Does `Object.freeze` seal every part of a value of this kind? True only where the content is the
 * value's own properties (or a slot nothing can write). A `Record`, so a new kind does not compile
 * until it is decided here.
 */
export const SEALABLE: { readonly [K in ValueKind]: boolean } = /* @__PURE__ */ Object.freeze({
  plain: true,
  array: true,
  boxed: true,
  date: false, // setTime & co. write its time value
  regexp: false, // compile() rewrites source and flags, even on a frozen one
  map: false, // set / delete / clear
  set: false, // add / delete / clear
  error: false, // V8's own `stack` accessor writes through a frozen error
  buffer: false, // its bytes, through any view; transfer() detaches it
  view: false, // index writes, set, fill, sort, copyWithin …
  opaque: false, // content this library cannot read — never assumed sealed
});

/** A prototype → its kind, for every built-in the clone produces (one Map lookup). */
const BY_PROTOTYPE: ReadonlyMap<object, ValueKind> = /* @__PURE__ */ prototypeTable();

function prototypeTable(): Map<object, ValueKind> {
  const table = new Map<object, ValueKind>();
  const global = globalThis as Record<string, unknown>;
  const add = (name: string, kind: ValueKind) => {
    const proto = (global[name] as { prototype?: unknown } | undefined)?.prototype;
    if (proto !== null && typeof proto === 'object') table.set(proto, kind);
  };
  add('Date', 'date');
  add('RegExp', 'regexp');
  add('Map', 'map');
  add('Set', 'set');
  for (const name of ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']) {
    add(name, 'error');
  }
  for (const name of ['Boolean', 'Number', 'String', 'BigInt']) add(name, 'boxed');
  for (const name of ['ArrayBuffer', 'SharedArrayBuffer']) add(name, 'buffer');
  add('DataView', 'view');
  // `Float16Array` is newer than the library's target; a runtime without it simply has no row.
  for (const bits of ['Int8', 'Uint8', 'Uint8Clamped', 'Int16', 'Uint16', 'Int32', 'Uint32', 'Float16', 'Float32']) {
    add(`${bits}Array`, 'view');
  }
  for (const name of ['Float64Array', 'BigInt64Array', 'BigUint64Array']) add(name, 'view');
  return table;
}

/** Prototypes classified by a probe clone of their first instance (see {@link kindOf}). */
const PROBED = new WeakMap<object, ValueKind>();

/**
 * The kind of an object, as a record holds it. A plain object or an array — the bulk of state —
 * costs one `Array.isArray` and one `getPrototypeOf`; a built-in one more Map lookup.
 *
 * Any other object is classified by WHAT ITS CLONE IS, once per prototype: a class instance comes
 * back a plain object (`'plain'`), a subclass of a built-in comes back the built-in (a `Map` subclass
 * is a `'map'`, Node's `Buffer` a `'view'`, a Date from another realm a `'date'`), and a host object
 * comes back as itself (`'opaque'`). An instance the clone refuses is `'opaque'` — it cannot be held,
 * and its commit will refuse it.
 */
export function kindOf(value: object): ValueKind {
  if (Array.isArray(value)) return 'array';
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return 'plain';
  return BY_PROTOTYPE.get(proto) ?? PROBED.get(proto) ?? probe(value, proto);
}

function probe(value: object, proto: object): ValueKind {
  let clone: unknown;
  try {
    clone = structuredClone(value);
  } catch {
    return 'opaque';
  }
  const cloneProto = clone !== null && typeof clone === 'object' ? Object.getPrototypeOf(clone) : undefined;
  const kind: ValueKind = Array.isArray(clone)
    ? 'array'
    : cloneProto === Object.prototype || cloneProto === null
    ? 'plain'
    : BY_PROTOTYPE.get(cloneProto as object) ?? 'opaque';
  PROBED.set(proto, kind);
  return kind;
}
