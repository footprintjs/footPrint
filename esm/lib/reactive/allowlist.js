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
export function shouldWrapWithProxy(value) {
    if (value === null || typeof value !== 'object')
        return false;
    // Frozen/sealed objects: nested set traps would silently fail, so return unwrapped.
    // Users must replace the entire value: scope.config = { ...scope.config, key: 'new' }
    if (Object.isFrozen(value) || Object.isSealed(value))
        return false;
    if (Array.isArray(value))
        return true;
    // Plain objects and null-prototype objects -- wrappable (no tag check needed)
    const ctor = value.constructor;
    if (ctor === undefined || ctor === Object)
        return true;
    // Built-ins with internal slots -- not wrappable
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (NON_PROXY_TAGS.has(tag))
        return false;
    // Any remaining non-Object constructor = class instance -- not wrappable
    return false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWxsb3dsaXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9yZWFjdGl2ZS9hbGxvd2xpc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7R0FVRztBQUVILGtGQUFrRjtBQUNsRixNQUFNLGNBQWMsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUM3QixNQUFNO0lBQ04sUUFBUTtJQUNSLEtBQUs7SUFDTCxLQUFLO0lBQ0wsU0FBUztJQUNULFNBQVM7SUFDVCxhQUFhO0lBQ2IsbUJBQW1CO0lBQ25CLFVBQVU7SUFDVixPQUFPO0lBQ1AsV0FBVztJQUNYLFlBQVk7SUFDWixnQkFBZ0I7SUFDaEIsYUFBYTtJQUNiLFdBQVc7SUFDWCxVQUFVO0lBQ1YsU0FBUztJQUNULFdBQVc7SUFDWCxZQUFZO0lBQ1osbUJBQW1CO0lBQ25CLFlBQVk7SUFDWixhQUFhO0lBQ2IsWUFBWTtJQUNaLGFBQWE7SUFDYixjQUFjO0lBQ2QsY0FBYztJQUNkLGVBQWU7SUFDZixnQkFBZ0I7SUFDaEIsU0FBUztJQUNULHNCQUFzQjtDQUN2QixDQUFDLENBQUM7QUFFSDs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFDSCxNQUFNLFVBQVUsbUJBQW1CLENBQUMsS0FBYztJQUNoRCxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBRTlELG9GQUFvRjtJQUNwRixzRkFBc0Y7SUFDdEYsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFFbkUsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBRXRDLDhFQUE4RTtJQUM5RSxNQUFNLElBQUksR0FBSSxLQUFpQyxDQUFDLFdBQVcsQ0FBQztJQUM1RCxJQUFJLElBQUksS0FBSyxTQUFTLElBQUksSUFBSSxLQUFLLE1BQU07UUFBRSxPQUFPLElBQUksQ0FBQztJQUV2RCxpREFBaUQ7SUFDakQsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvRCxJQUFJLGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFFMUMseUVBQXlFO0lBQ3pFLE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogcmVhY3RpdmUvYWxsb3dsaXN0IC0tIERldGVybWluZXMgd2hpY2ggdmFsdWVzIHNob3VsZCBiZSB3cmFwcGVkIGluIGRlZXAgUHJveGllcy5cbiAqXG4gKiBPbmx5IHBsYWluIG9iamVjdHMgKHt9KSBhbmQgYXJyYXlzIGdldCBkZWVwIFByb3h5IHdyYXBwaW5nIGZvciB3cml0ZSBpbnRlcmNlcHRpb24uXG4gKiBFdmVyeXRoaW5nIGVsc2UgKERhdGUsIE1hcCwgU2V0LCBSZWdFeHAsIGNsYXNzIGluc3RhbmNlcywgVHlwZWRBcnJheXMsIGV0Yy4pIGlzXG4gKiByZXR1cm5lZCB1bndyYXBwZWQgdG8gcHJldmVudCBpbnRlcm5hbCBzbG90IGVycm9ycy5cbiAqXG4gKiBWOCBQcm94eSB0cmFwcyBjYW5ub3QgZm9yd2FyZCBpbnRlcm5hbCBzbG90cyAoW1tEYXRlVmFsdWVdXSwgW1tNYXBEYXRhXV0sIGV0Yy4pLFxuICogc28gcHJveHlpbmcgYSBEYXRlIGFuZCBjYWxsaW5nIC5nZXRUaW1lKCkgdGhyb3dzIFwidGhpcyBpcyBub3QgYSBEYXRlIG9iamVjdFwiLlxuICogVnVlIDMgYW5kIE1vYlggYm90aCB1c2UgdGhlIHNhbWUgYWxsb3dsaXN0IGFwcHJvYWNoLlxuICovXG5cbi8qKiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nIHRhZ3MgZm9yIGJ1aWx0LWluIHR5cGVzIHRoYXQgbXVzdCBOT1QgYmUgcHJveGllZC4gKi9cbmNvbnN0IE5PTl9QUk9YWV9UQUdTID0gbmV3IFNldChbXG4gICdEYXRlJyxcbiAgJ1JlZ0V4cCcsXG4gICdNYXAnLFxuICAnU2V0JyxcbiAgJ1dlYWtNYXAnLFxuICAnV2Vha1NldCcsXG4gICdBcnJheUJ1ZmZlcicsXG4gICdTaGFyZWRBcnJheUJ1ZmZlcicsXG4gICdEYXRhVmlldycsXG4gICdFcnJvcicsXG4gICdFdmFsRXJyb3InLFxuICAnUmFuZ2VFcnJvcicsXG4gICdSZWZlcmVuY2VFcnJvcicsXG4gICdTeW50YXhFcnJvcicsXG4gICdUeXBlRXJyb3InLFxuICAnVVJJRXJyb3InLFxuICAnUHJvbWlzZScsXG4gICdJbnQ4QXJyYXknLFxuICAnVWludDhBcnJheScsXG4gICdVaW50OENsYW1wZWRBcnJheScsXG4gICdJbnQxNkFycmF5JyxcbiAgJ1VpbnQxNkFycmF5JyxcbiAgJ0ludDMyQXJyYXknLFxuICAnVWludDMyQXJyYXknLFxuICAnRmxvYXQzMkFycmF5JyxcbiAgJ0Zsb2F0NjRBcnJheScsXG4gICdCaWdJbnQ2NEFycmF5JyxcbiAgJ0JpZ1VpbnQ2NEFycmF5JyxcbiAgJ1dlYWtSZWYnLFxuICAnRmluYWxpemF0aW9uUmVnaXN0cnknLFxuXSk7XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBzaG91bGQgYmUgd3JhcHBlZCBpbiBhIGRlZXAgUHJveHkuXG4gKlxuICogT25seSBwbGFpbiBvYmplY3RzICh7fSkgYW5kIGFycmF5cyBhcmUgd3JhcHBhYmxlLlxuICogUHJpbWl0aXZlcywgbnVsbCwgRGF0ZSwgTWFwLCBTZXQsIFJlZ0V4cCwgY2xhc3MgaW5zdGFuY2VzLCBldGMuIGFyZSBOT1Qgd3JhcHBlZC5cbiAqXG4gKiBEZXRlY3Rpb24gc3RyYXRlZ3kgKG9yZGVyIG1hdHRlcnMpOlxuICogMS4gUHJpbWl0aXZlcyBhbmQgbnVsbCAtPiBmYWxzZSAoZmFzdCBleGl0KVxuICogMi4gRnJvemVuL3NlYWxlZCBvYmplY3RzIC0+IGZhbHNlIChuZXN0ZWQgc2V0IHRyYXBzIHdvdWxkIHNpbGVudGx5IGZhaWwpXG4gKiAzLiBBcnJheXMgLT4gdHJ1ZSAoZmFzdCBleGl0KVxuICogNC4gQ29uc3RydWN0b3IgY2hlY2sgLT4gcGxhaW4gb2JqZWN0cyAoT2JqZWN0IG9yIHVuZGVmaW5lZCkgYXJlIHdyYXBwYWJsZVxuICogNS4gVGFnIGNoZWNrIC0+IGNhdGNoIGJ1aWx0LWlucyB3aXRoIGludGVybmFsIHNsb3RzIChEYXRlLCBNYXAsIFNldCwgZXRjLilcbiAqIDYuIEV2ZXJ5dGhpbmcgZWxzZSAtPiBjbGFzcyBpbnN0YW5jZSwgbm90IHdyYXBwYWJsZVxuICpcbiAqIENvbnN0cnVjdG9yIGNoZWNrIGNvbWVzIEJFRk9SRSB0YWcgY2hlY2sgdG8gcHJldmVudCBTeW1ib2wudG9TdHJpbmdUYWcgc3Bvb2Zpbmc6XG4gKiBhIHBsYWluIG9iamVjdCB3aXRoIHsgW1N5bWJvbC50b1N0cmluZ1RhZ106ICdEYXRlJyB9IHdvdWxkIGZvb2wgdGhlIHRhZyBjaGVja1xuICogYnV0IGlzIGNvcnJlY3RseSBpZGVudGlmaWVkIGFzIGEgcGxhaW4gb2JqZWN0IGJ5IHRoZSBjb25zdHJ1Y3RvciBjaGVjay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFdyYXBXaXRoUHJveHkodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBmYWxzZTtcblxuICAvLyBGcm96ZW4vc2VhbGVkIG9iamVjdHM6IG5lc3RlZCBzZXQgdHJhcHMgd291bGQgc2lsZW50bHkgZmFpbCwgc28gcmV0dXJuIHVud3JhcHBlZC5cbiAgLy8gVXNlcnMgbXVzdCByZXBsYWNlIHRoZSBlbnRpcmUgdmFsdWU6IHNjb3BlLmNvbmZpZyA9IHsgLi4uc2NvcGUuY29uZmlnLCBrZXk6ICduZXcnIH1cbiAgaWYgKE9iamVjdC5pc0Zyb3plbih2YWx1ZSkgfHwgT2JqZWN0LmlzU2VhbGVkKHZhbHVlKSkgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gUGxhaW4gb2JqZWN0cyBhbmQgbnVsbC1wcm90b3R5cGUgb2JqZWN0cyAtLSB3cmFwcGFibGUgKG5vIHRhZyBjaGVjayBuZWVkZWQpXG4gIGNvbnN0IGN0b3IgPSAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmNvbnN0cnVjdG9yO1xuICBpZiAoY3RvciA9PT0gdW5kZWZpbmVkIHx8IGN0b3IgPT09IE9iamVjdCkgcmV0dXJuIHRydWU7XG5cbiAgLy8gQnVpbHQtaW5zIHdpdGggaW50ZXJuYWwgc2xvdHMgLS0gbm90IHdyYXBwYWJsZVxuICBjb25zdCB0YWcgPSBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLnNsaWNlKDgsIC0xKTtcbiAgaWYgKE5PTl9QUk9YWV9UQUdTLmhhcyh0YWcpKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQW55IHJlbWFpbmluZyBub24tT2JqZWN0IGNvbnN0cnVjdG9yID0gY2xhc3MgaW5zdGFuY2UgLS0gbm90IHdyYXBwYWJsZVxuICByZXR1cm4gZmFsc2U7XG59XG4iXX0=