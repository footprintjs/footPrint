/**
 * reactive/writeTraps — where a proxy's writes LAND, and the two traps that
 * send them there.
 *
 * Every object proxy in this folder (nested, terminal, element) intercepts
 * the same three things — a property set, a property delete, and an array
 * mutation somewhere below it — and differs only in where the write goes:
 * a nested/terminal proxy commits under a TOP-LEVEL KEY (an object write as
 * `merge` of a patch, an array write or a delete as `set` of the rebuilt
 * root); an element proxy commits the WHOLE OWNING ARRAY back through the
 * array proxy's own callback. That difference is a {@link WriteSink}; the
 * traps are written once over it (9.23.1 — the 9.22.0 stale-read bug was
 * fixed in one copy of these traps and then found again in the other two).
 */

import { nativeGet } from 'foottrace/paths';

import { unwrapHandles } from './handles.js';
import type { MemberCache } from './liveView.js';
import { buildNestedPatch } from './pathBuilder.js';
import { deleteInPath, setInPath } from './structuralWrite.js';

/**
 * The seam between a proxy and state. `path` is measured from the sink's
 * root — the key's value for {@link rootKeySink}, the element for
 * {@link elementSink}; `[]` is the root itself.
 */
export interface WriteSink {
  /** The value at `path`, as it stands NOW (read-your-writes; never a tracked read). */
  readAt(path: readonly string[]): unknown;
  /** Put an already-unwrapped `value` at `path`. The sink chooses the verb. */
  put(path: readonly string[], value: unknown): void;
  /** Remove the key at `path`. */
  remove(path: readonly string[]): void;
  /** The name of the value at `path` as a stage author writes it (`order.lines[0].qty`), for messages. */
  nameOf(path: readonly string[]): string;
}

/** `base` followed by `path`, dot-separated (`base` may be empty). */
function joinName(base: string, path: readonly string[]): string {
  return [base, ...path].filter((part) => part !== '').join('.');
}

/** The two ways a value reaches a state key: what the sink writes through. */
export interface RootKeyTarget {
  setValue(key: string, value: unknown): void;
  updateValue(key: string, value: unknown): void;
}

/**
 * WHY: a write below a top-level key has TWO verbs (reactive/README.md, law
 * 3) — an object leaf is a `merge` of a nested patch, an array leaf or a
 * delete rebuilds the root immutably and commits a `set` of the key. Only the
 * sink knows that; the traps do not. Every write drops the key's cached child
 * proxy (`cache`), so the next read is built over the new value.
 */
export function rootKeySink(
  target: RootKeyTarget,
  readSilent: (key: string) => unknown,
  rootKey: string,
  cache: Pick<MemberCache, 'delete'>,
): WriteSink {
  return new RootKeySink(target, readSilent, rootKey, cache);
}

/** One allocation per top-level read miss (the methods live on the prototype). */
class RootKeySink implements WriteSink {
  constructor(
    private readonly target: RootKeyTarget,
    private readonly readSilent: (key: string) => unknown,
    private readonly rootKey: string,
    private readonly cache: Pick<MemberCache, 'delete'>,
  ) {}

  /** An empty path is the key's own value — `nativeGet(v, [])` would return it unchanged, so the walk is skipped. */
  readAt(path: readonly string[]): unknown {
    const root = this.readSilent(this.rootKey);
    return path.length === 0 ? root : nativeGet(root, path as string[]);
  }

  put(path: readonly string[], value: unknown): void {
    if (!Array.isArray(value)) this.target.updateValue(this.rootKey, buildNestedPatch(path as string[], value));
    else this.target.setValue(this.rootKey, path.length === 0 ? value : setInPath(this.readAt([]), path, value));
    this.cache.delete(this.rootKey);
  }

  remove(path: readonly string[]): void {
    this.target.setValue(this.rootKey, deleteInPath(this.readAt([]), path));
    this.cache.delete(this.rootKey);
  }

  nameOf(path: readonly string[]): string {
    return joinName(this.rootKey, path);
  }
}

/**
 * WHY: a write inside an array element is an array write — it rebuilds the
 * owning array immutably and hands the WHOLE new array to the array proxy's
 * commit, the funnel `push` already uses. `path` is measured from the
 * element; `[]` is the element slot itself.
 */
export function elementSink(
  getCurrent: () => unknown[],
  commit: (next: unknown[]) => void,
  index: number,
  arrayName = '',
  forWrite: () => unknown[] = getCurrent,
): WriteSink {
  return new ElementSink(getCurrent, commit, index, arrayName, forWrite);
}

/** One allocation per element proxy (the methods live on the prototype) — a 10k-element loop builds 10k of these. */
class ElementSink implements WriteSink {
  constructor(
    private readonly getCurrent: () => unknown[],
    private readonly commit: (next: unknown[]) => void,
    private readonly index: number,
    private readonly arrayName: string,
    /** The owning array for a WRITE: the array proxy refuses it once its key holds no array (`arrayTraps.ts`). */
    private readonly forWrite: () => unknown[],
  ) {}

  readAt(path: readonly string[]): unknown {
    return readInElement(this.getCurrent, this.index, path);
  }

  nameOf(path: readonly string[]): string {
    return joinName(`${this.arrayName}[${this.index}]`, path);
  }

  put(path: readonly string[], value: unknown): void {
    replaceInElement(this.forWrite, this.commit, this.index, path, value);
  }

  remove(path: readonly string[]): void {
    removeInElement(this.forWrite, this.commit, this.index, path);
  }
}

/** The value at `path` inside element `index`, as it stands NOW (read-your-writes). */
function readInElement(getCurrent: () => unknown[], index: number, path: readonly string[]): unknown {
  const element = getCurrent()[index];
  return path.length === 0 ? element : nativeGet(element, path as string[]);
}

/** A copy of the array with `value` at `path` inside element `index`; a gone element has nothing to write into. */
function replaceInElement(
  getCurrent: () => unknown[],
  commit: (next: unknown[]) => void,
  index: number,
  path: readonly string[],
  value: unknown,
): void {
  const next = [...getCurrent()];
  if (index >= next.length) return;
  next[index] = path.length === 0 ? value : setInPath(next[index], path, value);
  commit(next);
}

/** A copy of the array with the key at `path` inside element `index` removed. */
function removeInElement(
  getCurrent: () => unknown[],
  commit: (next: unknown[]) => void,
  index: number,
  path: readonly string[],
): void {
  const next = [...getCurrent()];
  if (index >= next.length) return;
  next[index] = deleteInPath(next[index], path);
  commit(next);
}

/**
 * WHY one set trap: the assigned value is taken as a VALUE here (a handle
 * becomes what it stands for, `handles.ts`; nothing else is copied — the
 * buffer detaches at commit) and handed to the sink at the proxy's path plus
 * the key.
 */
export function sinkSetTrap(sink: WriteSink, segments: readonly string[]): ProxyHandler<object>['set'] {
  return (_target, prop, value) => {
    if (typeof prop !== 'string') return true;
    sink.put([...segments, prop], unwrapHandles(value));
    return true;
  };
}

/**
 * WHY one delete trap: `merge` cannot express a removal (a patch of
 * `undefined` reads as absent), so a delete always rebuilds through the sink.
 */
export function sinkDeleteTrap(sink: WriteSink, segments: readonly string[]): ProxyHandler<object>['deleteProperty'] {
  return (_target, prop) => {
    if (typeof prop !== 'string') return true;
    sink.remove([...segments, prop]);
    return true;
  };
}

// -- The other write doors ----------------------------------------------------
//
// A property can also be written without an assignment: `Object.defineProperty`,
// `Object.setPrototypeOf`, `Object.freeze` / `seal` / `preventExtensions`. With no
// trap these reach the RAW object the proxy stands for: committed state changes
// and the record has no row. The law is the same as for `set`: no state change
// without a row. What a row can hold is plain data, so a define that is exactly
// an assignment is recorded as one, and everything else is refused out loud.

/** Why a define, a prototype change or a lock is refused. One wording for every proxy kind. */
export function refuseDoor(what: string, path: string): never {
  throw new TypeError(
    `Cannot ${what} on scope state${path ? ` ('${path}')` : ''}: the record holds plain data only. ` +
      'Assign a value instead; to replace an object, assign a new one.',
  );
}

/**
 * Is `descriptor` exactly what an assignment makes? Either all-open
 * (`value` with writable, enumerable and configurable all true), or a bare
 * `{ value }` for a key that already exists (the shape `Reflect.set` sends to a
 * receiver). An accessor, or any attribute set to false, is not.
 */
export function isAssignmentDescriptor(descriptor: PropertyDescriptor, exists: boolean): boolean {
  const has = (name: keyof PropertyDescriptor) => Object.prototype.hasOwnProperty.call(descriptor, name);
  if (!has('value') || has('get') || has('set')) return false;
  const attributes = (['writable', 'enumerable', 'configurable'] as const).filter(has);
  if (attributes.length === 0) return exists;
  return attributes.length === 3 && attributes.every((name) => descriptor[name] === true);
}

/**
 * WHY three more traps: the doors above, closed for every object proxy over a
 * {@link WriteSink}. A define that is an assignment goes to the sink (a row);
 * any other define, a prototype change and a lock are refused. A symbol key is
 * not state (a record never holds one) and passes through to the target, as it
 * always did.
 */
export function sinkDoorTraps(
  sink: WriteSink,
  segments: readonly string[],
): Pick<ProxyHandler<object>, 'defineProperty' | 'setPrototypeOf' | 'preventExtensions'> {
  const pathOf = (prop?: string) => (prop === undefined ? segments : [...segments, prop]).join('.');
  return {
    defineProperty(target, prop, descriptor) {
      if (typeof prop !== 'string') return Reflect.defineProperty(target, prop, descriptor);
      const current = sink.readAt(segments);
      const exists =
        current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, prop);
      if (!isAssignmentDescriptor(descriptor, exists))
        refuseDoor('define a property with special attributes', pathOf(prop));
      sink.put([...segments, prop], unwrapHandles(descriptor.value));
      return true;
    },
    setPrototypeOf() {
      return refuseDoor('change the prototype of a value', pathOf());
    },
    preventExtensions() {
      return refuseDoor('freeze, seal or lock a value', pathOf());
    },
  };
}
