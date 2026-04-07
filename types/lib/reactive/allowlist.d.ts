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
export declare function shouldWrapWithProxy(value: unknown): boolean;
