/**
 * freeze.ts — the ONE deep-freeze walk (moved here from `scope/protection/readonlyInput.ts` in F3).
 *
 * WHY HERE. Four places freeze a tree: run args (`readonlyInput · createFrozenArgs`), the fold base
 * served as `initialState` (`ExecutionRuntime · getFoldBase`), the dev-mode snapshot
 * (`FlowChartExecutor · getSnapshot`) and, since F3, every commit bundle (`EventLog · record`).
 * `memory/` must not import `scope/` (that edge closed the memory ⇄ scope ⇄ recorder module cycle
 * F0 removed), so the walk lives in this leaf, which imports nothing.
 *
 * @example
 * ```typescript
 * import { deepFreeze } from './freeze.js';
 *
 * const args = deepFreeze({ order: Object.freeze({ lines: [{ sku: 'A' }] }) });
 * Object.isFrozen(args.order.lines[0]); // true — a shallow-frozen input is still walked
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
 * - An object that is ALREADY frozen is still descended, once: a shallow-frozen input
 *   (`Object.freeze({ inner: { x: 1 } })`) comes out with `inner` frozen too. The walk remembers
 *   the frozen objects it descended in a `WeakSet` created on first need, which is what ends a
 *   cycle or a repeated reference. A fresh tree (every object unfrozen when first reached, none
 *   reached twice) never creates the set, and a frozen object with no object below it (a frozen
 *   list of names) needs neither the descent nor the set.
 * - ArrayBuffer views (typed arrays, `DataView`) are skipped: `Object.freeze` throws on a non-empty
 *   typed array, so a `Uint8Array` in state, args or the fold base used to fail the run or the
 *   snapshot here.
 * - What `Object.freeze` cannot reach stays mutable — Map and Set contents, a Date's time, the
 *   bytes behind a buffer. A frozen RegExp's `lastIndex` is read-only, so a `/g` or `/y` regex
 *   taken from a frozen tree throws when `exec` or `replace` advance it.
 * - Functions are not descended (they are not values the engine stores).
 */
export function deepFreeze<T>(obj: T, arrays: ArrayWalk = 'every-key'): T {
  freezeValue(obj, { indices: arrays === 'indices', seen: undefined });
  return obj;
}

/** One {@link deepFreeze} call's walk: how arrays are enumerated, and the set made on first need. */
interface FreezeWalk {
  readonly indices: boolean;
  seen: WeakSet<object> | undefined;
}

function freezeValue(value: unknown, walk: FreezeWalk): void {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
  if (Object.isFrozen(value)) {
    // Frozen before this walk reached it (a shallow-frozen input), or frozen by this walk and met
    // again (a cycle, a shared reference): descend it ONCE.
    if (!hasObjectChild(value, walk)) return;
    const seen = (walk.seen ??= new WeakSet<object>());
    if (seen.has(value)) return;
    seen.add(value);
  } else {
    Object.freeze(value);
  }
  // The two loops are written out (here and in hasObjectChild) rather than shared through a
  // callback: this runs once per object of every commit, and a closure per object is measurable.
  if (walk.indices && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child: unknown = value[i];
      if (child !== null && typeof child === 'object') freezeValue(child, walk);
    }
    return;
  }
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i++) {
    const child = (value as Record<string, unknown>)[names[i]];
    if (child !== null && typeof child === 'object') freezeValue(child, walk);
  }
}

/** Does `value` hold an object anywhere the walk would descend? */
function hasObjectChild(value: object, walk: FreezeWalk): boolean {
  if (walk.indices && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child: unknown = value[i];
      if (child !== null && typeof child === 'object') return true;
    }
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i++) {
    const child = (value as Record<string, unknown>)[names[i]];
    if (child !== null && typeof child === 'object') return true;
  }
  return false;
}
