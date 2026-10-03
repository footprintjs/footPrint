/**
 * freeze.ts — the ONE deep-freeze walk (moved here from `scope/protection/readonlyInput.ts` in F3).
 *
 * WHY HERE. Five places freeze a tree, all through this walk: run args (`readonlyInput ·
 * createFrozenArgs`), the fold base served as `initialState` (`ExecutionRuntime · getFoldBase`), the
 * dev-mode snapshot (`runner/snapshot.ts · servedSnapshot`), every state `stateAt` hands out
 * (`time-travel/stateAt.ts`) and, since F3, every commit bundle (`EventLog · record`). `memory/` must
 * not import `scope/` (that edge closed the memory ⇄ scope ⇄ recorder module cycle F0 removed), so the
 * walk lives in this leaf, which imports nothing.
 *
 * @example
 * ```typescript
 * import { deepFreeze } from './freeze.js';
 *
 * const args = deepFreeze({ order: { lines: [{ sku: 'A' }] }, bytes: new Uint8Array([1]) });
 * Object.isFrozen(args.order.lines[0]); // true
 * Object.isFrozen(args.bytes); // false — a typed array cannot be frozen; it is skipped
 * ```
 */

/**
 * How {@link deepFreeze} walks an ARRAY.
 *
 * - `'every-key'` (the default) — every own property, as for any other object: the index elements
 *   AND any expando (`arr.note = { … }`). The contract args protection and the dev-mode snapshot
 *   rely on.
 * - `'indices'` — the index elements only, so no key string is allocated per element; this is what
 *   keeps freezing a 10,000-element commit inside its budget (`bench/element-writes.ts`). An object
 *   hung on an array EXPANDO is then left unfrozen — the commit log's named hole
 *   (`EventLog · record`).
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
 *   taken from a frozen tree throws when `exec` or `replace` advance it.
 * - Functions are not descended (they are not values the engine stores).
 */
export function deepFreeze<T>(obj: T, arrays: ArrayWalk = 'every-key'): T {
  freezeValue(obj, arrays === 'indices');
  return obj;
}

function freezeValue(value: unknown, indices: boolean): void {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return;
  Object.freeze(value);
  // The two loops are written out rather than shared through a callback: this runs once per object of
  // every commit, and a closure per object is measurable.
  if (indices && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child: unknown = value[i];
      if (child !== null && typeof child === 'object') freezeValue(child, indices);
    }
    return;
  }
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i++) {
    const child = (value as Record<string, unknown>)[names[i]];
    if (child !== null && typeof child === 'object') freezeValue(child, indices);
  }
}
