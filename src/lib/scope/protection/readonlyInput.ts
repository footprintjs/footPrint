/**
 * readonlyInput — Utilities for readonly input enforcement.
 *
 * Provides:
 * - assertNotReadonly(): throws if a key belongs to the readonly input
 * - createFrozenArgs(): snapshots owned input containers without freezing the caller
 * - snapshotRunInput(): the ONE snapshot a run leg takes, handed to every scope of it
 *
 * Used by both ScopeFacade (class-based scopes) and attachScopeMethods
 * (non-class scopes). This is an ownership boundary, not an in-place freezer:
 * live capabilities and explicitly frozen wrappers are borrowed, never walked.
 * Saved records still use `capture/freeze.ts · deepFreeze` unchanged.
 */

/**
 * Throws if `key` is an own property of `readOnlyValues`.
 * Safe against prototype pollution — uses `hasOwnProperty` on the specific object.
 */
export function assertNotReadonly(readOnlyValues: unknown, key: string, operation: 'write' | 'delete'): void {
  if (
    readOnlyValues &&
    typeof readOnlyValues === 'object' &&
    Object.prototype.hasOwnProperty.call(readOnlyValues, key)
  ) {
    if (operation === 'delete') {
      throw new Error(`Cannot delete readonly input key "${key}" — input values are immutable`);
    }
    throw new Error(`Cannot write to readonly input key "${key}" — use getArgs() to read input values`);
  }
}

/**
 * Creates a frozen argument view, copying mutable ordinary records and arrays.
 * Functions, opaque objects and already-frozen nested values remain borrowed —
 * so over a {@link snapshotRunInput} snapshot (every container already frozen)
 * a scope pays only O(root keys). Called once per scope at construction.
 */
export function createFrozenArgs(readOnlyValues: unknown): Record<string, unknown> {
  if (!readOnlyValues || typeof readOnlyValues !== 'object') {
    return Object.freeze({});
  }
  const args = { ...(readOnlyValues as Record<string, unknown>) };
  // Root spread semantics: a plain record of own enumerable string/symbol keys,
  // even for array input. Seed before walking so root cycles close on the copy.
  const copies = new WeakMap<object, object>([[readOnlyValues, args]]);
  copyProperties(args, args, copies);
  return Object.freeze(args);
}

/** One memoized traversal: copy each owned container once, then freeze only it. */
function snapshotValue(value: unknown, copies: WeakMap<object, object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = copies.get(value);
  if (existing) return existing;
  if (Object.isFrozen(value)) return value;

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) return value;

  const copy: object = isArray ? Object.setPrototypeOf(new Array(value.length), prototype) : Object.create(prototype);
  copies.set(value, copy);
  copyProperties(value, copy, copies);
  return Object.freeze(copy);
}

/** Materialize accessors once; define data keys safely, including __proto__. */
function copyProperties(source: object, target: object, copies: WeakMap<object, object>): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    // An array already owns its non-configurable length; holes remain holes.
    if (Array.isArray(target) && key === 'length') continue;
    const value = snapshotValue(Reflect.get(source, key), copies);
    Object.defineProperty(target, key, {
      value,
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * The ONE owned, frozen input snapshot of a run leg — taken once per `run()` /
 * `resume()` traverser (and per subflow mount, whose mapped input is its own)
 * and handed to every scope factory of that leg. A caller edit to the input
 * after the leg starts reaches no scope of it. Non-object input passes through.
 */
export function snapshotRunInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  // The snapshot root keeps ALL the input's own keys (non-enumerable ones
  // included), so the readonly-key check over it refuses exactly what it
  // refused over the input. A borrowed root (opaque or caller-frozen) is not
  // copied by the walk, so its keys are copied onto a plain frozen record here.
  const owned = snapshotValue(input, new WeakMap());
  if (owned !== input) return owned;
  const root = {};
  copyProperties(input, root, new WeakMap<object, object>([[input, root]]));
  return Object.freeze(root);
}
