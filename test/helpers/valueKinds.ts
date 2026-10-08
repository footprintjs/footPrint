/**
 * Every kind of value a record can hold, for the record-truth tests (9.45.0) — built from the RUNTIME,
 * never from the library under test:
 *
 *   - `cloneable`  a fast-check arbitrary over every kind `structuredClone` keeps that state may hold
 *                  (plain objects, arrays, class instances, Date, RegExp, Map, Set, every Error type,
 *                  boxed primitives, ArrayBuffer — resizable too — every typed array, DataView, Blob),
 *                  nested; small domains, so near-misses are common (a DOMException is left out: its clone
 *                  differs by runtime — itself on Node 24, a plain `{}` on Node 22)
 *   - `recordKey`  an independent oracle: the value as a record holds it, as one string — built from
 *                  `Object.prototype.toString` tags, `structuredClone` and raw bytes. Two values hold the
 *                  same thing iff their keys are equal (a length-tracking view and a fixed view of the
 *                  same bytes aside: nothing can tell them apart without resizing the buffer)
 *   - `vandalize`  everything a holder can try on what it holds, applied to every object reachable from a
 *                  root: every method of its prototypes with several argument shapes, assignment, delete
 *                  and defineProperty of its own and its content-bearing names, writes through a view,
 *                  `transfer()`. Counts the attempts that did not throw
 */
import v8 from 'node:v8';

import fc from 'fast-check';

const ids = new WeakMap<object, number>();
let nextId = 0;
function idOf(value: object): number {
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = nextId++));
  return id;
}

/** A class whose instances the clone flattens to a plain object. */
export class Point {
  constructor(public x: unknown) {}
}

const TYPED = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;
const ERRORS = [Error, TypeError, RangeError, EvalError, ReferenceError, SyntaxError, URIError] as const;

const small = fc.constantFrom('a', 'b');
const smallInt = fc.integer({ min: 0, max: 2 });
const bytes = fc.uint8Array({ minLength: 0, maxLength: 3 }).map((b) => b.map((x) => x % 2));

function bufferOf(content: Uint8Array, resizable: boolean): ArrayBuffer {
  const buffer = resizable
    ? new (ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => ArrayBuffer)(content.length, {
        maxByteLength: content.length + 4,
      })
    : new ArrayBuffer(content.length);
  new Uint8Array(buffer).set(content);
  return buffer;
}

/** A leaf of every kind that is not a container of other values. */
const leaf: fc.Arbitrary<unknown> = fc.oneof(
  smallInt,
  small,
  fc.constant(null),
  fc.constant(undefined),
  fc.constantFrom(0, -0, Number.NaN, 1.5),
  fc.boolean(),
  fc.bigInt({ min: 0n, max: 2n }),
  fc.constantFrom(0, 1, Number.NaN).map((t) => new Date(t)),
  fc.tuple(small, fc.constantFrom('', 'g', 'i', 'gi', 'y')).map(([source, flags]) => new RegExp(source, flags)),
  fc.oneof(
    smallInt.map((n) => Object(n)),
    small.map((s) => Object(s)),
    fc.boolean().map((b) => Object(b)),
  ),
  fc.bigInt({ min: 0n, max: 2n }).map((n) => Object(n)),
  fc.tuple(bytes, fc.boolean()).map(([b, resizable]) => bufferOf(b, resizable)),
  fc
    .tuple(fc.integer({ min: 0, max: TYPED.length - 1 }), fc.integer({ min: 0, max: 1 }), smallInt, bytes)
    .map(([kind, offset, length, tail]) => {
      const Ctor = TYPED[kind];
      const size = Ctor.BYTES_PER_ELEMENT;
      const content = new Uint8Array((offset + length) * size + tail.length);
      content.set(tail, (offset + length) * size); // bytes beyond the view count too
      for (let i = 0; i < length * size; i++) content[offset * size + i] = i % 2;
      return new Ctor(content.buffer, offset * size, length);
    }),
  fc
    .tuple(bytes, smallInt)
    .map(([b, offset]) => new DataView(bufferOf(new Uint8Array([...b, 0, 0]), false), offset % 2)),
  small.map((s) => new Blob([s])),
);

/** Every kind, nested: plain objects, arrays, class instances, Maps, Sets, errors with a cause. */
export const cloneable: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.dictionary(fc.constantFrom('a', 'b', 'c'), tie('value'), { maxKeys: 3 }),
    fc.array(tie('value'), { maxLength: 3 }),
    tie('value').map((x) => new Point(x)),
    fc.array(fc.tuple(fc.oneof(small, smallInt), tie('value')), { maxLength: 3 }).map((entries) => new Map(entries)),
    fc
      .array(fc.oneof(small, smallInt, fc.dictionary(small, smallInt, { maxKeys: 1 })), { maxLength: 3 })
      .map((members) => new Set(members)),
    fc
      .tuple(fc.integer({ min: 0, max: ERRORS.length - 1 }), small, fc.option(tie('value'), { nil: undefined }))
      .map(([kind, message, cause]) =>
        cause === undefined ? new ERRORS[kind](message) : new ERRORS[kind](message, { cause }),
      ),
  ),
})).value;

/**
 * The value as a record holds it, as one string. `opaque: 'identity'` keys a Blob or DOMException by
 * the object (a record can only say it is the same one); `'kind'` keys it by its kind.
 */
export function recordKey(value: unknown, opaque: 'identity' | 'kind' = 'identity'): string {
  return keyOf(value, opaque);
}

function keyOf(v: unknown, opaque: 'identity' | 'kind'): string {
  if (v === undefined) return 'u';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isNaN(v) ? 'n:NaN' : `n:${v === 0 ? 0 : v}`;
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  if (typeof v === 'boolean' || typeof v === 'bigint') return `${typeof v}:${String(v)}`;
  if (typeof v !== 'object') throw new Error(`recordKey: no key for ${typeof v}`);
  const key = (x: unknown) => keyOf(x, opaque);
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) parts.push(key(v[i]));
    return `[${parts.join(',')}]`;
  }
  const tag = Object.prototype.toString.call(v).slice(8, -1);
  const o = v as Record<string, unknown>;
  switch (tag) {
    case 'Date':
      return `Date(${Number.isNaN((v as Date).getTime()) ? 'NaN' : (v as Date).getTime()})`;
    case 'RegExp':
      return `RegExp(${(v as RegExp).source}/${(v as RegExp).flags})`;
    case 'Map':
      return `Map{${[...(v as Map<unknown, unknown>)]
        .map(([k, x]) => `${key(k)}=>${key(x)}`)
        .sort()
        .join(',')}}`;
    case 'Set':
      return `Set{${[...(v as Set<unknown>)].map(key).sort().join(',')}}`;
    case 'Error': {
      const clone = structuredClone(v) as Error; // what the record keeps
      const message = Object.getOwnPropertyDescriptor(clone, 'message');
      const cause = Object.getOwnPropertyDescriptor(v, 'cause');
      return `Error(${clone.name}|${message ? clone.message : '-'}|${clone.stack}|${cause ? key(cause.value) : '-'})`;
    }
    case 'Number':
    case 'String':
    case 'Boolean':
    case 'BigInt':
      return `${tag}(${key((v as { valueOf(): unknown }).valueOf())})`;
    case 'Blob':
    case 'DOMException':
      return opaque === 'identity' ? `${tag}#${idOf(v)}` : tag;
    case 'Object':
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${key(o[k])}`)
        .join(',')}}`;
    default:
      // A buffer: its bytes, length and resizability. A typed array or DataView: its type, offset and
      // length over its WHOLE buffer — what `structuredClone` keeps (v8.serialize keeps only the view's
      // own bytes, so it cannot be the key).
      if (v instanceof ArrayBuffer) return `${tag}:${bufferKey(v)}`;
      if (ArrayBuffer.isView(v)) return `${tag}@${v.byteOffset}+${v.byteLength}:${bufferKey(v.buffer as ArrayBuffer)}`;
      throw new Error(`recordKey: no key for ${tag}`);
  }
}

function bufferKey(buffer: ArrayBuffer): string {
  const b = buffer as ArrayBuffer & { resizable?: boolean; maxByteLength?: number };
  return `${Buffer.from(new Uint8Array(buffer)).toString('hex')}|${b.resizable === true ? `r${b.maxByteLength}` : 'f'}`;
}

/** Argument shapes every method is tried with — enough to reach every mutator of every kind. */
const ARGS: unknown[][] = [[], [0], [1, 2], [0, 9], ['zz', 'g'], [[9]]];
const NAMES = ['lastIndex', 'stack', 'message', 'cause', 'name', 'x', '0', 'length', 'size', 'byteLength'];

/** Where a value sits under the root `vandalize` was handed: property names, `<key>` / `<value>` / `<member>`. */
export type VandalPath = readonly string[];

export interface VandalOptions {
  /** Leave this value (and everything under it) untouched — a documented LIVE view. */
  readonly skip?: (path: VandalPath) => boolean;
  /** Told every value visited, with its path — so a test can prove what the walk reached. */
  readonly onVisit?: (path: VandalPath) => void;
  readonly budget?: number;
}

/**
 * Try every mutation on every object reachable from `root` (children first, through reads — what a holder
 * reaches). Returns how many attempts did not throw. A held `Map`'s or `Set`'s keys and members, an
 * error's `cause`, and own non-enumerable values are reached too.
 */
export function vandalize(root: unknown, options: VandalOptions | number = {}): number {
  const { skip, onVisit, budget = 20_000 } = typeof options === 'number' ? { budget: options } : options;
  const seen = new Set<object>();
  let landed = 0;
  const visit = (v: unknown, path: VandalPath): void => {
    if (v === null || typeof v !== 'object' || seen.has(v) || seen.size >= budget) return;
    if (skip?.(path)) return;
    seen.add(v);
    onVisit?.(path);
    const children: Array<[string, unknown]> = [];
    try {
      if (v instanceof Map) for (const [k, x] of v) children.push(['<key>', k], ['<value>', x]);
      if (v instanceof Set) for (const x of v) children.push(['<member>', x]);
      for (const name of Object.getOwnPropertyNames(v)) children.push([name, (v as Record<string, unknown>)[name]]);
    } catch {
      /* a detached buffer's view, an accessor that throws */
    }
    for (const [name, child] of children) visit(child, [...path, name]);
    landed += attack(v);
  };
  visit(root, []);
  return landed;
}

function attack(v: object): number {
  let landed = 0;
  const attempt = (f: () => unknown) => {
    try {
      const out = f();
      if (out && typeof (out as Promise<unknown>).then === 'function')
        (out as Promise<unknown>).then(undefined, () => {});
      landed++;
    } catch {
      /* refused */
    }
  };
  for (let p = Object.getPrototypeOf(v); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      const method = Object.getOwnPropertyDescriptor(p, name)?.value;
      if (name === 'constructor' || typeof method !== 'function') continue;
      for (const args of ARGS) attempt(() => method.apply(v, args));
    }
  }
  for (const name of [...Object.getOwnPropertyNames(v), ...NAMES]) {
    attempt(() => {
      (v as Record<string, unknown>)[name] = 'forged';
    });
    attempt(() => Object.defineProperty(v, name, { value: 'forged' }));
    attempt(() => delete (v as Record<string, unknown>)[name]);
  }
  if (v instanceof ArrayBuffer) attempt(() => new Uint8Array(v).fill(7));
  if (ArrayBuffer.isView(v)) attempt(() => new Uint8Array(v.buffer).fill(7));
  return landed;
}
