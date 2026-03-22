/**
 * reactive/allowlist -- Determines which values should be wrapped in deep Proxies.
 *
 * Only plain objects ({}) and arrays get deep Proxy wrapping for write interception.
 * Everything else (Date, Map, Set, RegExp, class instances, TypedArrays, etc.) is
 * returned unwrapped to prevent internal slot errors.
 *
 * V8 Proxy traps cannot forward internal slots ([[DateValue]], [[MapData]], etc.),
 * so proxying a Date and calling .getTime() throws "this is not a Date object".
 * Vue 3 and MobX both use the same allowlist approach.
 */

/** Object.prototype.toString tags for built-in types that must NOT be proxied. */
const NON_PROXY_TAGS = new Set([
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Promise',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'WeakRef',
  'FinalizationRegistry',
]);

/**
 * Returns true if the value should be wrapped in a deep Proxy.
 *
 * Only plain objects ({}) and arrays are wrappable.
 * Primitives, null, Date, Map, Set, RegExp, class instances, etc. are NOT wrapped.
 *
 * Detection strategy (order matters):
 * 1. Primitives and null -> false (fast exit)
 * 2. Frozen/sealed objects -> false (nested set traps would silently fail)
 * 3. Arrays -> true (fast exit)
 * 4. Constructor check -> plain objects (Object or undefined) are wrappable
 * 5. Tag check -> catch built-ins with internal slots (Date, Map, Set, etc.)
 * 6. Everything else -> class instance, not wrappable
 *
 * Constructor check comes BEFORE tag check to prevent Symbol.toStringTag spoofing:
 * a plain object with { [Symbol.toStringTag]: 'Date' } would fool the tag check
 * but is correctly identified as a plain object by the constructor check.
 */
export function shouldWrapWithProxy(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;

  // Frozen/sealed objects: nested set traps would silently fail, so return unwrapped.
  // Users must replace the entire value: scope.config = { ...scope.config, key: 'new' }
  if (Object.isFrozen(value) || Object.isSealed(value)) return false;

  if (Array.isArray(value)) return true;

  // Plain objects and null-prototype objects -- wrappable (no tag check needed)
  const ctor = (value as Record<string, unknown>).constructor;
  if (ctor === undefined || ctor === Object) return true;

  // Built-ins with internal slots -- not wrappable
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (NON_PROXY_TAGS.has(tag)) return false;

  // Any remaining non-Object constructor = class instance -- not wrappable
  return false;
}
