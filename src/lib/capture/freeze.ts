/**
 * freeze.ts — the ONE deep-freeze walk (moved here from `scope/protection/readonlyInput.ts` in F3),
 * and the serve-time law for a frozen record (9.45.0).
 *
 * WHY HERE. Saved trees freeze through this walk: the fold base served as
 * `initialState` (`ExecutionRuntime · getFoldBase`), the
 * dev-mode snapshot (`runner/snapshot.ts · servedSnapshot`), every state `stateAt` hands out
 * (`time-travel/stateAt.ts`) and, since F3, every commit bundle (`EventLog · record`). `memory/` must
 * not import `scope/` (that edge closed the memory ⇄ scope ⇄ recorder module cycle F0 removed), so the
 * walk lives in this leaf folder, which imports nothing outside itself. Args use an ownership snapshot
 * instead (`scope/protection/readonlyInput.ts · createFrozenArgs`): never freeze borrowed caller values.
 *
 * FREEZE WHAT CAN BE FROZEN, COPY WHAT CAN'T (9.45.0). `Object.freeze` cannot seal a Date's time, a
 * Map's or Set's entries, a buffer's bytes, a RegExp (`compile()` rewrites a frozen one) or an Error
 * (V8's own `stack` accessor writes through a frozen one). A fresh tree handed to one caller (a `stateAt`
 * state, the dev-mode snapshot) is that caller's own, so freezing it is a guard and nothing more. A
 * RECORD — a commit bundle, the fold base — is served to every reader, so {@link freezeRecord} remembers
 * which ones hold such a value and {@link serveRecord} hands each reader a fresh copy of those: until
 * 9.45.0 `snapshot.commitLog[i].overwrite.when.setTime(0)` rewrote every later snapshot, `stateAt`,
 * `commitValueAt`, slice and cursor answer.
 *
 * @example
 * ```typescript
 * import { deepFreeze, freezeRecord, serveRecord } from './freeze.js';
 *
 * const args = deepFreeze({ order: { lines: [{ sku: 'A' }] }, bytes: new Uint8Array([1]) });
 * Object.isFrozen(args.order.lines[0]); // true
 * Object.isFrozen(args.bytes); // false — a typed array cannot be frozen; it is skipped
 *
 * const record = freezeRecord({ when: new Date(0) });
 * serveRecord(record).when.setTime(5); // changes the reader's copy
 * serveRecord(record).when.getTime(); // 0 — every serve is the record as recorded
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
 *   taken from a frozen tree throws when `exec` or `replace` advance it. A tree many readers are
 *   served goes through {@link freezeRecord} and {@link serveRecord} instead.
 * - Functions are not descended (they are not values the engine stores).
 */
export function deepFreeze<T>(obj: T, arrays: ArrayWalk = 'every-key'): T {
  freezeValue(obj, arrays === 'indices', false);
  return obj;
}

/**
 * The records a reader is SERVED — each commit bundle (`EventLog · record`), the fold base
 * (`ExecutionRuntime · getFoldBase`), a retained read or write (`StageContext`), a subflow's stored
 * tree — that hold a value `Object.freeze` cannot seal: a Date, a Map, a Set, a RegExp, an Error, a
 * buffer or a view (`valueKinds.ts · SEALABLE`). Held weakly.
 */
const OPEN = new WeakSet<object>();

/** The records `freezeRecord` froze and found sealed whole — served as themselves, never looked through again. */
const SEALED = new WeakSet<object>();

/**
 * {@link deepFreeze} for a record many readers are SERVED, remembering whether freezing sealed all of
 * it. Returns `record`. A part that was frozen before is not frozen past (deepFreeze's contract) but is
 * still looked through, so a value freezing cannot seal inside it still marks the record.
 */
export function freezeRecord<T extends object>(record: T, arrays: ArrayWalk = 'every-key'): T {
  if (OPEN.has(record) || SEALED.has(record)) return record;
  (freezeValue(record, arrays === 'indices', true) ? OPEN : SEALED).add(record);
  return record;
}

/**
 * The record as a reader may hold it — THE serve-time law for a frozen record: freeze what can be
 * frozen, copy what can't. A record freezing sealed whole is served as itself (shared, no cost); one
 * that holds a value freezing cannot seal is served as a fresh frozen COPY, so its Dates, Maps and
 * buffers are the reader's own and the record's stay out of reach. A copy is served the same way
 * again, so a record stored from one serve (a subflow's result) is still copied for the next.
 */
export function serveRecord<T>(record: T): T {
  return holdsUnsealed(record) ? freezeRecord(structuredClone(record) as T & object) : record;
}

/**
 * A value the library keeps and OWNS (its own clone: a retained read or write) as a reader may hold
 * it: frozen once, in place, on its first serve, then {@link serveRecord} — so a sealed one (the common
 * case) costs one lookup per serve.
 */
export function serveOwned<T extends object>(value: T): T {
  if (SEALED.has(value)) return value;
  return serveRecord(freezeRecord(value));
}

/**
 * A value the library KEEPS but cannot freeze in place — a diagnostic bag holding the app's own
 * objects, a recorder's row, a chart's structure — as a reader may hold it: a fresh copy, the reader's
 * own (not frozen: nothing else reads it). A value `structuredClone` refuses (a function in a
 * diagnostic) cannot be copied and is served as it is — the one value this law cannot reach.
 */
export function serveCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Does `record` (one {@link freezeRecord} froze) hold a value freezing cannot seal? */
export function holdsUnsealed(record: unknown): boolean {
  return record !== null && typeof record === 'object' && OPEN.has(record);
}

/** Freeze `value` deep; `true` when it holds a value freezing cannot seal. */
function freezeValue(value: unknown, indices: boolean, detect: boolean): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return true; // its bytes — and a non-empty one cannot be frozen at all
  if (Object.isFrozen(value)) {
    return detect && !SEALED.has(value) && (OPEN.has(value) || unsealedInside(value, new WeakSet()));
  }
  Object.freeze(value);
  let open = !SEALABLE[kindOf(value)];
  // The two loops are written out rather than shared through a callback: this runs once per object of
  // every commit, and a closure per object is measurable.
  if (indices && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child: unknown = value[i];
      if (child !== null && typeof child === 'object' && freezeValue(child, indices, detect)) open = true;
    }
    return open;
  }
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i++) {
    const child = (value as Record<string, unknown>)[names[i]];
    if (child !== null && typeof child === 'object' && freezeValue(child, indices, detect)) open = true;
  }
  return open;
}

/** Does an object frozen before `freezeRecord` met it hold a value freezing cannot seal? A look, no freeze. */
function unsealedInside(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  if (SEALED.has(value)) return false;
  if (ArrayBuffer.isView(value) || !SEALABLE[kindOf(value)] || OPEN.has(value)) return true;
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i++) {
    const child = (value as Record<string, unknown>)[names[i]];
    if (child !== null && typeof child === 'object' && unsealedInside(child, seen)) return true;
  }
  return false;
}
