/**
 * freeze.ts — the ONE deep-freeze walk (moved here from `scope/protection/readonlyInput.ts` in F3),
 * and the serve-time law for the commit log (9.44.2).
 *
 * WHY HERE. Saved trees freeze through this walk: the fold base served as
 * `initialState` (`ExecutionRuntime · getFoldBase`), the
 * dev-mode snapshot (`runner/snapshot.ts · servedSnapshot`), every state `stateAt` hands out
 * (`time-travel/stateAt.ts`) and, since F3, every commit bundle (`EventLog · record`). `memory/` must
 * not import `scope/` (that edge closed the memory ⇄ scope ⇄ recorder module cycle F0 removed), so the
 * walk lives in this leaf folder, which imports nothing outside itself. Args use an ownership snapshot
 * instead (`scope/protection/readonlyInput.ts · createFrozenArgs`): never freeze borrowed caller values.
 *
 * FREEZE WHAT CAN BE FROZEN, COPY WHAT CAN'T (9.44.2). `Object.freeze` cannot seal a Date's time, a
 * Map's or Set's entries, a buffer's bytes, a RegExp (`compile()` rewrites a frozen one) or an Error
 * (V8's own `stack` accessor writes through a frozen one). A fresh tree handed to one caller (a `stateAt`
 * state, the dev-mode snapshot) is that caller's own, so freezing it is a guard and nothing more. The
 * COMMIT LOG — each bundle, and the fold base — is served to every reader, so {@link freezeRecord}
 * remembers that a record holds such a value, its first serve maps the containers on the way to each
 * one (its open PATHS), and {@link serveRecord} hands a reader a copy of those paths only: a fresh copy
 * of each such value, fresh frozen containers on the way to it, and every other part shared, frozen, as
 * it is. Until 9.44.2 `snapshot.commitLog[i].overwrite.when.setTime(0)` rewrote every later snapshot,
 * `stateAt`, `commitValueAt`, slice and cursor answer.
 *
 * Every walk here is ITERATIVE (an explicit stack): a record's depth is not bounded by the call stack.
 *
 * @example
 * ```typescript
 * import { deepFreeze, freezeRecord, serveRecord } from './freeze.js';
 *
 * const args = deepFreeze({ order: { lines: [{ sku: 'A' }] }, bytes: new Uint8Array([1]) });
 * Object.isFrozen(args.order.lines[0]); // true
 * Object.isFrozen(args.bytes); // false — a typed array cannot be frozen; it is skipped
 *
 * const record = freezeRecord({ when: new Date(0), tags: ['a'] });
 * const served = serveRecord(record);
 * served.when.setTime(5); // changes the reader's copy
 * serveRecord(record).when.getTime(); // 0 — every serve is the record as recorded
 * served.tags === record.tags; // true — the sealed part is shared, not copied
 * serveRecord(freezeRecord({ n: 1 })); // a record freezing sealed whole: served as itself
 * ```
 */

import { kindOf, SEALABLE } from './valueKinds.js';

/**
 * How {@link deepFreeze} walks an ARRAY.
 *
 * - `'every-key'` (the default) — every own property, as for any other object: the index elements
 *   AND any expando (`arr.note = { … }`). The dev-mode snapshot relies on this contract.
 * - `'indices'` — the index elements only, so no key string is allocated per element; this is what
 *   keeps freezing a 10,000-element commit inside its budget (`bench/element-writes.ts`). An object
 *   hung on an array EXPANDO is then left unfrozen, and unseen by {@link serveRecord} — the commit
 *   log's named hole (`EventLog · record`; an array expando is out of contract for state).
 */
export type ArrayWalk = 'every-key' | 'indices';

/**
 * Freezes `obj` and every object reachable through its own properties, and returns `obj`.
 *
 * - An object that is ALREADY frozen is left as it is, and not descended — 9.32.0's contract, kept:
 *   args may hold a caller's frozen object with live parts inside (a class instance a stage calls),
 *   and freezing past it would break them. It is also what ends a cycle. The commit log never meets
 *   one: its payloads are fresh `structuredClone`s.
 * - ArrayBuffer views (typed arrays, `DataView`) are skipped: `Object.freeze` throws on a non-empty
 *   typed array, so a `Uint8Array` in state, args or the fold base used to fail the run or the
 *   snapshot here.
 * - What `Object.freeze` cannot reach stays mutable — Map and Set contents, a Date's time, the
 *   bytes behind a buffer. A frozen RegExp's `lastIndex` is read-only, so a `/g` or `/y` regex
 *   taken from a frozen tree throws when `exec` or `replace` advance it. The commit log goes through
 *   {@link freezeRecord} and {@link serveRecord} instead.
 * - Functions are not descended (they are not values the engine stores).
 */
export function deepFreeze<T>(obj: T, arrays: ArrayWalk = 'every-key'): T {
  if (obj !== null && typeof obj === 'object') walkAndFreeze(obj, arrays === 'indices', false);
  return obj;
}

/**
 * Containers of a record that hold — on some path below them — a value freezing cannot seal: `true` once
 * mapped (the container is on an open path), `false` for a record {@link freezeRecord} found open whose
 * paths no serve has mapped yet. A container absent here is sealed whole.
 */
const OPEN = new WeakMap<object, boolean>();

/**
 * {@link deepFreeze} for a record many readers are SERVED (a commit bundle, the fold base), and two more
 * things on the same walk:
 *
 *   - it remembers THAT the record holds a value freezing cannot seal — one flag; the record's first
 *     serve maps WHERE (the containers on the way to each such value, its open paths), so the run pays
 *     nothing more and {@link serveRecord} copies those paths and nothing else;
 *   - a typed array or `DataView` that views a SLICE of a bigger buffer (a Node `Buffer` views its
 *     shared pool) is replaced, in the record, by a copy of the bytes it views — the record keeps the
 *     view's bytes, never the rest of the buffer (a resizable or shared buffer is kept as it is).
 *
 * A part frozen before is not frozen past (deepFreeze's contract) but is looked through, so a value
 * freezing cannot seal inside it still opens the record. Returns `record`.
 */
export function freezeRecord<T extends object>(record: T, arrays: ArrayWalk = 'every-key'): T {
  if (!OPEN.has(record) && walkAndFreeze(record, arrays === 'indices', true)) OPEN.set(record, false);
  return record;
}

/**
 * The record as a reader may hold it — THE serve-time law: a record freezing sealed whole is served as
 * itself (shared, no cost); any other as a copy of its open paths ({@link freezeRecord}): fresh frozen
 * containers down to each value freezing cannot seal, a fresh copy of that value, and every other part
 * shared, frozen, as it is. A copy is served the same way again.
 */
export function serveRecord<T>(record: T): T {
  if (record === null || typeof record !== 'object') return record;
  const mapped = OPEN.get(record);
  if (mapped === undefined) return record;
  if (!mapped) mapOpenPaths(record);
  return OPEN.get(record) === true ? (copyOpenPaths(record) as T) : record;
}

/** A value freezing cannot seal — a view, or a kind `SEALABLE` says no to (a Date, a Map, an Error …). */
function isUnsealable(value: object): boolean {
  return ArrayBuffer.isView(value) || !SEALABLE[kindOf(value)];
}

/**
 * Freeze `root` and every container under it, iteratively; `record` adds the look-through of parts
 * frozen before and the compaction of views over a slice. `true` when something under `root` (or `root`
 * itself) cannot be sealed.
 */
function walkAndFreeze(root: object, indices: boolean, record: boolean): boolean {
  let open = false;
  let lookedThrough: Set<object> | undefined;
  const stack: object[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ArrayBuffer.isView(node)) {
      open = true; // its bytes — and a non-empty one cannot be frozen at all
      continue;
    }
    const frozenBefore = Object.isFrozen(node);
    if (frozenBefore) {
      if (!record || OPEN.has(node)) {
        open ||= record;
        continue;
      }
      if ((lookedThrough ??= new Set()).has(node)) continue;
      lookedThrough.add(node); // a part frozen before: looked through, never frozen past
    }
    if (record && !open && !SEALABLE[kindOf(node)]) open = true;
    // Children first, while `node` is still open to the compaction below; then the freeze.
    const compacting = record && !frozenBefore;
    if (indices && Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child: unknown = node[i];
        if (child === null || typeof child !== 'object') continue;
        stack.push(compacting && ArrayBuffer.isView(child) ? compact(node, i, child) : child);
      }
    } else {
      const names = Object.getOwnPropertyNames(node);
      for (let i = 0; i < names.length; i++) {
        const child = (node as Record<string, unknown>)[names[i]];
        if (child === null || typeof child !== 'object') continue;
        stack.push(compacting && ArrayBuffer.isView(child) ? compact(node, names[i], child) : child);
      }
    }
    if (!frozenBefore) Object.freeze(node);
  }
  return open;
}

/**
 * A view over a SLICE of a bigger buffer, replaced in `container` by a copy of the bytes it views
 * (the type it is — a Node `Buffer` comes out a `Uint8Array`, as a clone of it does). Anything else is
 * returned as it is. A resizable or shared buffer is kept: a copy would change what it is.
 */
function compact(container: object, key: string | number, child: ArrayBufferView): object {
  const buffer = child.buffer as ArrayBuffer & { resizable?: boolean };
  if (child.byteOffset === 0 && child.byteLength === buffer.byteLength) return child;
  if (buffer.resizable === true || !(buffer instanceof ArrayBuffer)) return child;
  const bytes = buffer.slice(child.byteOffset, child.byteOffset + child.byteLength);
  const tag = Object.prototype.toString.call(child).slice(8, -1);
  const Ctor = (globalThis as unknown as Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>)[tag];
  if (typeof Ctor !== 'function') return child;
  const copy = new Ctor(bytes);
  try {
    (container as Record<string | number, unknown>)[key] = copy;
  } catch {
    return child; // a property the record does not let be replaced (a hand-built bundle)
  }
  return copy;
}

/**
 * Map the open paths of `root` — mark every container that reaches a value freezing cannot seal, so a
 * serve copies exactly those (DAGs and cycles included: the marks run UP the reverse edges from each
 * such value). Runs once per open record, at its first serve. A node's first holder is kept in one map;
 * any other holder (a shared part, a cycle) in a second, made only when there is one.
 */
function mapOpenPaths(root: object): void {
  const holder = new Map<object, object>();
  let moreHolders: Map<object, object[]> | undefined;
  const leaves: object[] = [];
  const stack: object[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isUnsealable(node)) {
      leaves.push(node); // a leaf: its contents are copied with it
      continue;
    }
    const names = Object.keys(node);
    for (let i = 0; i < names.length; i++) {
      const child = (node as Record<string, unknown>)[names[i]];
      if (child === null || typeof child !== 'object') continue;
      if (child !== root && !holder.has(child)) {
        holder.set(child, node);
        stack.push(child);
        continue;
      }
      const more = (moreHolders ??= new Map()).get(child);
      if (more === undefined) moreHolders.set(child, [node]);
      else more.push(node);
    }
  }
  // Marked in THIS map, not by an earlier one: a part another record already mapped still opens
  // every container of this record on the way to it.
  const marked = new Set<object>();
  const up: object[] = [];
  const holdersOf = (node: object): void => {
    const first = holder.get(node);
    if (first !== undefined) up.push(first);
    const more = moreHolders?.get(node);
    // One push per holder: a spread passes every holder as a call argument, and one object held by
    // 120,000 containers overflowed the stack.
    if (more !== undefined) for (let i = 0; i < more.length; i++) up.push(more[i]);
  };
  for (const leaf of leaves) {
    if (leaf === root) marked.add(root);
    holdersOf(leaf);
  }
  while (up.length > 0) {
    const node = up.pop()!;
    if (marked.has(node)) continue;
    marked.add(node);
    holdersOf(node);
  }
  // Only now, the walk done, does the record's flag give way to its map: a mapping that throws leaves
  // the record flagged, so the next serve maps again — it never hands out the record itself.
  if (!marked.has(root)) OPEN.delete(root);
  for (const node of marked) OPEN.set(node, true);
}

/**
 * The served copy of an open record: its open containers copied (fresh, then frozen, and themselves
 * open — a copy is served by copy again), each value freezing cannot seal copied, every sealed part
 * shared. Iterative; one copy per original, so containers shared or cyclic stay shared in the copy. The
 * values freezing cannot seal are copied ONE BY ONE: two of them that share a part (an `ArrayBuffer`
 * and a view of it, an error whose `cause` is another key's Date) come out as separate copies — equal
 * values, the sharing between them not kept.
 */
function copyOpenPaths(root: object): object {
  const copies = new Map<object, object>();
  const shells: object[] = [];
  const copyOf = (value: object, pending: object[]): object => {
    const done = copies.get(value);
    if (done !== undefined) return done;
    let copy: object;
    if (isUnsealable(value)) {
      copy = copyLeaf(value);
    } else {
      copy = Array.isArray(value) ? new Array(value.length) : {};
      shells.push(copy);
      pending.push(value);
    }
    copies.set(value, copy);
    return copy;
  };
  const pending: object[] = [];
  const out = copyOf(root, pending);
  while (pending.length > 0) {
    const node = pending.pop()!;
    const copy = copies.get(node) as Record<string, unknown>;
    for (const name of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[name];
      putOwn(
        copy,
        name,
        child !== null && typeof child === 'object' && (OPEN.has(child) || isUnsealable(child))
          ? copyOf(child, pending)
          : child,
      );
    }
  }
  for (const shell of shells) {
    Object.freeze(shell);
    OPEN.set(shell, true);
  }
  // A leaf copy is the reader's own; frozen where freezing reaches, as the record's parts are.
  for (const copy of copies.values()) if (!ArrayBuffer.isView(copy)) Object.freeze(copy);
  return out;
}

/**
 * `target[name] = value`, as an OWN data property. A key the shell only inherits — an own `"__proto__"`
 * of the record (`JSON.parse` makes one) — would call the inherited setter and re-parent the copy; it is
 * defined as data instead, as `memory/merge.ts · mergeGuarded` keeps it.
 */
function putOwn(target: Record<string, unknown>, name: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(target, name) && Reflect.has(target, name)) {
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[name] = value;
  }
}

/** A fresh copy of a value freezing cannot seal. One the clone refuses (hand-built) is served as it is. */
function copyLeaf(value: object): object {
  if (kindOf(value) === 'date') return new Date(Date.prototype.getTime.call(value));
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
