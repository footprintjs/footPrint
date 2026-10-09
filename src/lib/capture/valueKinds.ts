/**
 * valueKinds.ts — what KIND of value a record holds: the one classifier.
 *
 * WHY. Committed state is what survives `structuredClone` (an engine invariant), so the values a
 * record holds are the kinds the clone keeps. Two laws need the kind, and both ask here:
 *
 *   - what counts as a CHANGE (`memory/equality.ts · deepEqual`): two values are equal when a record
 *     holds the same thing for both, compared kind by kind. Until 9.44.2 only Date, Map and Set had a
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

/** What a brand check returns, when it does not throw, for a value without the slot. */
const NOT_BRAND = Symbol('not the brand');

/**
 * A built-in kind is known by its BRAND — an internal slot only the real thing has — never by its
 * prototype: `Object.create(RegExp.prototype)` is not a RegExp (its clone is `{}`), and reading
 * `source` from it throws. The candidate comes from `Object.prototype.toString` (one call), then ONE
 * brand-checked read confirms it; a value that fails it is classified by its clone instead.
 */
const BRANDS: ReadonlyMap<string, { readonly kind: ValueKind; readonly check: (value: object) => unknown }> =
  /* @__PURE__ */ brandTable();

function brandTable(): Map<string, { kind: ValueKind; check: (value: object) => unknown }> {
  const getter = (proto: object | undefined, key: string): ((value: object) => unknown) | undefined => {
    const get = proto && Object.getOwnPropertyDescriptor(proto, key)?.get;
    return get ? (value) => get.call(value) : undefined;
  };
  const global = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
  const isError = (Error as unknown as { isError?: (value: unknown) => boolean }).isError;
  const rows: Array<[string, ValueKind, ((value: object) => unknown) | undefined]> = [
    ['Date', 'date', (value) => Date.prototype.getTime.call(value)],
    ['RegExp', 'regexp', getter(RegExp.prototype, 'source')],
    ['Map', 'map', getter(Map.prototype, 'size')],
    ['Set', 'set', getter(Set.prototype, 'size')],
    // An error's tag comes from its own [[ErrorData]] slot: no Error prototype carries a toStringTag. Where
    // the brand check `Error.isError` is missing (Node 22), a tag a getter supplies is therefore a spoof.
    ['Error', 'error', (value) => ((isError ? isError(value) : untagged(value)) ? true : NOT_BRAND)],
    ['Number', 'boxed', (value) => Number.prototype.valueOf.call(value)],
    ['String', 'boxed', (value) => String.prototype.valueOf.call(value)],
    ['Boolean', 'boxed', (value) => Boolean.prototype.valueOf.call(value)],
    ['BigInt', 'boxed', (value) => (global.BigInt?.prototype as { valueOf(): unknown }).valueOf.call(value)],
    ['ArrayBuffer', 'buffer', getter(ArrayBuffer.prototype, 'byteLength')],
    ['SharedArrayBuffer', 'buffer', getter(global.SharedArrayBuffer?.prototype, 'byteLength')],
  ];
  const table = new Map<string, { kind: ValueKind; check: (value: object) => unknown }>();
  for (const [name, kind, check] of rows) if (check) table.set(`[object ${name}]`, { kind, check });
  return table;
}

/** No `Symbol.toStringTag` on the value or its prototypes: its tag came from a slot. */
function untagged(value: object): boolean {
  return (value as Record<symbol, unknown>)[Symbol.toStringTag] === undefined;
}

/** The kind of a built-in value, by its brand — `undefined` for anything else. */
function builtinKind(value: object): ValueKind | undefined {
  if (ArrayBuffer.isView(value)) return 'view'; // a brand check of its own: [[ViewedArrayBuffer]]
  const brand = BRANDS.get(Object.prototype.toString.call(value));
  if (brand === undefined) return undefined;
  try {
    return brand.check(value) === NOT_BRAND ? undefined : brand.kind;
  } catch {
    return undefined; // the prototype without the slot
  }
}

/** Prototypes classified by a probe clone of their first instance (see {@link kindOf}). */
const PROBED = new WeakMap<object, ValueKind>();

/**
 * The kind of an object, as a record holds it. A plain object or an array — the bulk of state —
 * costs one `Array.isArray` and one `getPrototypeOf`; a built-in a tag and one brand-checked read.
 * The brand is the value's own slot, so a subclass (a `Map` subclass is a `'map'`, Node's `Buffer` a
 * `'view'`) and a value from another realm land on their kind.
 *
 * Any other object is classified by WHAT ITS CLONE IS, once per prototype: a class instance comes
 * back a plain object (`'plain'`), a fake built-in (`Object.create(Date.prototype)`, or a class whose
 * `Symbol.toStringTag` says `'Date'`) comes back `{}` (`'plain'`), and a host object comes back as
 * itself (`'opaque'`). A prototype whose instance the clone refuses is `'opaque'` — remembered too:
 * it cannot be held, and its commit will refuse it.
 */
export function kindOf(value: object): ValueKind {
  if (Array.isArray(value)) return 'array';
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return 'plain';
  return builtinKind(value) ?? PROBED.get(proto) ?? probe(value, proto);
}

function probe(value: object, proto: object): ValueKind {
  let kind: ValueKind;
  try {
    const clone: unknown = structuredClone(value);
    kind = clone === null || typeof clone !== 'object' ? 'opaque' : kindOfClone(clone);
  } catch {
    kind = 'opaque';
  }
  PROBED.set(proto, kind);
  return kind;
}

/** The kind of a CLONE — a value of this realm, so its prototype or its brand decides it. */
function kindOfClone(clone: object): ValueKind {
  if (Array.isArray(clone)) return 'array';
  const proto = Object.getPrototypeOf(clone);
  if (proto === Object.prototype || proto === null) return 'plain';
  return builtinKind(clone) ?? 'opaque';
}
