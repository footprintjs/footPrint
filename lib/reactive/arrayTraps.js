"use strict";
/**
 * reactive/arrayTraps -- Array mutation interception via Proxy.
 *
 * When scope.items is an array, we return a Proxy that intercepts mutating
 * methods (push, pop, splice, etc.). Each mutation:
 * 1. Clones the current array
 * 2. Applies the mutation to the clone
 * 3. Commits the new array via the commit callback
 *
 * Non-mutating methods (map, filter, forEach, etc.) pass through to the
 * current array snapshot without interception.
 *
 * The original array in state is NEVER mutated directly -- all writes go
 * through the commit callback which calls setValue/updateValue.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArrayProxy = void 0;
/** Methods that mutate the array in-place. We intercept and copy-on-write. */
const MUTATING_METHODS = new Set([
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse',
    'fill',
    'copyWithin',
]);
/**
 * Creates a Proxy over an array that intercepts mutating operations.
 *
 * @param getCurrent - Returns the current array snapshot from state
 * @param commit - Called with the new array after a mutation (triggers setValue)
 * @returns Proxied array with copy-on-write semantics
 */
function createArrayProxy(getCurrent, commit) {
    // Use the actual current array as the Proxy target. Node.js console.log
    // inspects the target directly (bypasses Proxy traps). By using the real
    // array, console.log shows correct values. The target reference is fixed
    // at creation time — after mutations, the proxy returns a new proxy
    // (via cache invalidation) with the fresh array as target.
    const target = getCurrent();
    return new Proxy(target, {
        get(_target, prop, receiver) {
            // Intercept mutating methods
            if (typeof prop === 'string' && MUTATING_METHODS.has(prop)) {
                return (...args) => {
                    const clone = [...getCurrent()];
                    const result = clone[prop](...args);
                    commit(clone);
                    return result;
                };
            }
            // Non-mutating access: delegate to the current array snapshot
            const current = getCurrent();
            // 'length' and index access
            if (prop === 'length')
                return current.length;
            // Numeric index access
            if (typeof prop === 'string') {
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0 && index < current.length) {
                    return current[index];
                }
            }
            // Node.js util.inspect custom formatting
            if (prop === Symbol.for('nodejs.util.inspect.custom')) {
                return () => current;
            }
            // Symbol.iterator and other built-in symbols
            if (typeof prop === 'symbol') {
                const val = current[prop];
                if (typeof val === 'function')
                    return val.bind(current);
                return val;
            }
            // All other methods (map, filter, forEach, find, etc.) -- bind to current
            const val = current[prop];
            if (typeof val === 'function')
                return val.bind(current);
            return val;
        },
        set(_target, prop, value) {
            // Index assignment: scope.items[2] = 'updated'
            if (typeof prop === 'string') {
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0) {
                    const clone = [...getCurrent()];
                    clone[index] = value;
                    commit(clone);
                    return true;
                }
            }
            // Setting 'length' (e.g., arr.length = 0 to clear)
            if (prop === 'length' && typeof value === 'number') {
                const clone = [...getCurrent()];
                clone.length = value;
                commit(clone);
                return true;
            }
            return true; // ignore other set operations
        },
        has(_target, prop) {
            const current = getCurrent();
            return Reflect.has(current, prop);
        },
        ownKeys() {
            const current = getCurrent();
            return Reflect.ownKeys(current);
        },
        getOwnPropertyDescriptor(_target, prop) {
            const current = getCurrent();
            return Object.getOwnPropertyDescriptor(current, prop);
        },
    });
}
exports.createArrayProxy = createArrayProxy;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXJyYXlUcmFwcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvcmVhY3RpdmUvYXJyYXlUcmFwcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7O0dBY0c7OztBQUVILDhFQUE4RTtBQUM5RSxNQUFNLGdCQUFnQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQy9CLE1BQU07SUFDTixLQUFLO0lBQ0wsT0FBTztJQUNQLFNBQVM7SUFDVCxRQUFRO0lBQ1IsTUFBTTtJQUNOLFNBQVM7SUFDVCxNQUFNO0lBQ04sWUFBWTtDQUNiLENBQUMsQ0FBQztBQUVIOzs7Ozs7R0FNRztBQUNILFNBQWdCLGdCQUFnQixDQUFJLFVBQXFCLEVBQUUsTUFBK0I7SUFDeEYsd0VBQXdFO0lBQ3hFLHlFQUF5RTtJQUN6RSx5RUFBeUU7SUFDekUsb0VBQW9FO0lBQ3BFLDJEQUEyRDtJQUMzRCxNQUFNLE1BQU0sR0FBRyxVQUFVLEVBQVMsQ0FBQztJQUVuQyxPQUFPLElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRTtRQUN2QixHQUFHLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxRQUFRO1lBQ3pCLDZCQUE2QjtZQUM3QixJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDM0QsT0FBTyxDQUFDLEdBQUcsSUFBZSxFQUFFLEVBQUU7b0JBQzVCLE1BQU0sS0FBSyxHQUFHLENBQUMsR0FBRyxVQUFVLEVBQUUsQ0FBQyxDQUFDO29CQUNoQyxNQUFNLE1BQU0sR0FBSSxLQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztvQkFDN0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO29CQUNkLE9BQU8sTUFBTSxDQUFDO2dCQUNoQixDQUFDLENBQUM7WUFDSixDQUFDO1lBRUQsOERBQThEO1lBQzlELE1BQU0sT0FBTyxH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O1lBQzdCLE9BQU8sTUFBTSxDQUFDLHdCQUF3QixDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQztRQUN4RCxDQUFDO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQTFGRCw0Q0EwRkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHJlYWN0aXZlL2FycmF5VHJhcHMgLS0gQXJyYXkgbXV0YXRpb24gaW50ZXJjZXB0aW9uIHZpYSBQcm94eS5cbiAqXG4gKiBXaGVuIHNjb3BlLml0ZW1zIGlzIGFuIGFycmF5LCB3ZSByZXR1cm4gYSBQcm94eSB0aGF0IGludGVyY2VwdHMgbXV0YXRpbmdcbiAqIG1ldGhvZHMgKHB1c2gsIHBvcCwgc3BsaWNlLCBldGMuKS4gRWFjaCBtdXRhdGlvbjpcbiAqIDEuIENsb25lcyB0aGUgY3VycmVudCBhcnJheVxuICogMi4gQXBwbGllcyB0aGUgbXV0YXRpb24gdG8gdGhlIGNsb25lXG4gKiAzLiBDb21taXRzIHRoZSBuZXcgYXJyYXkgdmlhIHRoZSBjb21taXQgY2FsbGJhY2tcbiAqXG4gKiBOb24tbXV0YXRpbmcgbWV0aG9kcyAobWFwLCBmaWx0ZXIsIGZvckVhY2gsIGV0Yy4pIHBhc3MgdGhyb3VnaCB0byB0aGVcbiAqIGN1cnJlbnQgYXJyYXkgc25hcHNob3Qgd2l0aG91dCBpbnRlcmNlcHRpb24uXG4gKlxuICogVGhlIG9yaWdpbmFsIGFycmF5IGluIHN0YXRlIGlzIE5FVkVSIG11dGF0ZWQgZGlyZWN0bHkgLS0gYWxsIHdyaXRlcyBnb1xuICogdGhyb3VnaCB0aGUgY29tbWl0IGNhbGxiYWNrIHdoaWNoIGNhbGxzIHNldFZhbHVlL3VwZGF0ZVZhbHVlLlxuICovXG5cbi8qKiBNZXRob2RzIHRoYXQgbXV0YXRlIHRoZSBhcnJheSBpbi1wbGFjZS4gV2UgaW50ZXJjZXB0IGFuZCBjb3B5LW9uLXdyaXRlLiAqL1xuY29uc3QgTVVUQVRJTkdfTUVUSE9EUyA9IG5ldyBTZXQoW1xuICAncHVzaCcsXG4gICdwb3AnLFxuICAnc2hpZnQnLFxuICAndW5zaGlmdCcsXG4gICdzcGxpY2UnLFxuICAnc29ydCcsXG4gICdyZXZlcnNlJyxcbiAgJ2ZpbGwnLFxuICAnY29weVdpdGhpbicsXG5dKTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgUHJveHkgb3ZlciBhbiBhcnJheSB0aGF0IGludGVyY2VwdHMgbXV0YXRpbmcgb3BlcmF0aW9ucy5cbiAqXG4gKiBAcGFyYW0gZ2V0Q3VycmVudCAtIFJldHVybnMgdGhlIGN1cnJlbnQgYXJyYXkgc25hcHNob3QgZnJvbSBzdGF0ZVxuICogQHBhcmFtIGNvbW1pdCAtIENhbGxlZCB3aXRoIHRoZSBuZXcgYXJyYXkgYWZ0ZXIgYSBtdXRhdGlvbiAodHJpZ2dlcnMgc2V0VmFsdWUpXG4gKiBAcmV0dXJucyBQcm94aWVkIGFycmF5IHdpdGggY29weS1vbi13cml0ZSBzZW1hbnRpY3NcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUFycmF5UHJveHk8VD4oZ2V0Q3VycmVudDogKCkgPT4gVFtdLCBjb21taXQ6IChuZXdBcnJheTogVFtdKSA9PiB2b2lkKTogVFtdIHtcbiAgLy8gVXNlIHRoZSBhY3R1YWwgY3VycmVudCBhcnJheSBhcyB0aGUgUHJveHkgdGFyZ2V0LiBOb2RlLmpzIGNvbnNvbGUubG9nXG4gIC8vIGluc3BlY3RzIHRoZSB0YXJnZXQgZGlyZWN0bHkgKGJ5cGFzc2VzIFByb3h5IHRyYXBzKS4gQnkgdXNpbmcgdGhlIHJlYWxcbiAgLy8gYXJyYXksIGNvbnNvbGUubG9nIHNob3dzIGNvcnJlY3QgdmFsdWVzLiBUaGUgdGFyZ2V0IHJlZmVyZW5jZSBpcyBmaXhlZFxuICAvLyBhdCBjcmVhdGlvbiB0aW1lIOKAlCBhZnRlciBtdXRhdGlvbnMsIHRoZSBwcm94eSByZXR1cm5zIGEgbmV3IHByb3h5XG4gIC8vICh2aWEgY2FjaGUgaW52YWxpZGF0aW9uKSB3aXRoIHRoZSBmcmVzaCBhcnJheSBhcyB0YXJnZXQuXG4gIGNvbnN0IHRhcmdldCA9IGdldEN1cnJlbnQoKSBhcyBUW107XG5cbiAgcmV0dXJuIG5ldyBQcm94eSh0YXJnZXQsIHtcbiAgICBnZXQoX3RhcmdldCwgcHJvcCwgcmVjZWl2ZXIpIHtcbiAgICAgIC8vIEludGVyY2VwdCBtdXRhdGluZyBtZXRob2RzXG4gICAgICBpZiAodHlwZW9mIHByb3AgPT09ICdzdHJpbmcnICYmIE1VVEFUSU5HX01FVEhPRFMuaGFzKHByb3ApKSB7XG4gICAgICAgIHJldHVybiAoLi4uYXJnczogdW5rbm93bltdKSA9PiB7XG4gICAgICAgICAgY29uc3QgY2xvbmUgPSBbLi4uZ2V0Q3VycmVudCgpXTtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSAoY2xvbmUgYXMgYW55KVtwcm9wXSguLi5hcmdzKTtcbiAgICAgICAgICBjb21taXQoY2xvbmUpO1xuICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIE5vbi1tdXRhdGluZyBhY2Nlc3M6IGRlbGVnYXRlIHRvIHRoZSBjdXJyZW50IGFycmF5IHNuYXBzaG90XG4gICAgICBjb25zdCBjdXJyZW50ID0gZ2V0Q3VycmVudCgpO1xuXG4gICAgICAvLyAnbGVuZ3RoJyBhbmQgaW5kZXggYWNjZXNzXG4gICAgICBpZiAocHJvcCA9PT0gJ2xlbmd0aCcpIHJldHVybiBjdXJyZW50Lmxlbmd0aDtcblxuICAgICAgLy8gTnVtZXJpYyBpbmRleCBhY2Nlc3NcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3QgaW5kZXggPSBOdW1iZXIocHJvcCk7XG4gICAgICAgIGlmIChOdW1iZXIuaXNJbnRlZ2VyKGluZGV4KSAmJiBpbmRleCA+PSAwICYmIGluZGV4IDwgY3VycmVudC5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm4gY3VycmVudFtpbmRleF07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gTm9kZS5qcyB1dGlsLmluc3BlY3QgY3VzdG9tIGZvcm1hdHRpbmdcbiAgICAgIGlmIChwcm9wID09PSBTeW1ib2wuZm9yKCdub2RlanMudXRpbC5pbnNwZWN0LmN1c3RvbScpKSB7XG4gICAgICAgIHJldHVybiAoKSA9PiBjdXJyZW50O1xuICAgICAgfVxuXG4gICAgICAvLyBTeW1ib2wuaXRlcmF0b3IgYW5kIG90aGVyIGJ1aWx0LWluIHN5bWJvbHNcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N5bWJvbCcpIHtcbiAgICAgICAgY29uc3QgdmFsID0gKGN1cnJlbnQgYXMgYW55KVtwcm9wXTtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpIHJldHVybiB2YWwuYmluZChjdXJyZW50KTtcbiAgICAgICAgcmV0dXJuIHZhbDtcbiAgICAgIH1cblxuICAgICAgLy8gQWxsIG90aGVyIG1ldGhvZHMgKG1hcCwgZmlsdGVyLCBmb3JFYWNoLCBmaW5kLCBldGMuKSAtLSBiaW5kIHRvIGN1cnJlbnRcbiAgICAgIGNvbnN0IHZhbCA9IChjdXJyZW50IGFzIGFueSlbcHJvcF07XG4gICAgICBpZiAodHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHZhbC5iaW5kKGN1cnJlbnQpO1xuICAgICAgcmV0dXJuIHZhbDtcbiAgICB9LFxuXG4gICAgc2V0KF90YXJnZXQsIHByb3AsIHZhbHVlKSB7XG4gICAgICAvLyBJbmRleCBhc3NpZ25tZW50OiBzY29wZS5pdGVtc1syXSA9ICd1cGRhdGVkJ1xuICAgICAgaWYgKHR5cGVvZiBwcm9wID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCBpbmRleCA9IE51bWJlcihwcm9wKTtcbiAgICAgICAgaWYgKE51bWJlci5pc0ludGVnZXIoaW5kZXgpICYmIGluZGV4ID49IDApIHtcbiAgICAgICAgICBjb25zdCBjbG9uZSA9IFsuLi5nZXRDdXJyZW50KCldO1xuICAgICAgICAgIGNsb25lW2luZGV4XSA9IHZhbHVlO1xuICAgICAgICAgIGNvbW1pdChjbG9uZSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU2V0dGluZyAnbGVuZ3RoJyAoZS5nLiwgYXJyLmxlbmd0aCA9IDAgdG8gY2xlYXIpXG4gICAgICBpZiAocHJvcCA9PT0gJ2xlbmd0aCcgJiYgdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICBjb25zdCBjbG9uZSA9IFsuLi5nZXRDdXJyZW50KCldO1xuICAgICAgICBjbG9uZS5sZW5ndGggPSB2YWx1ZTtcbiAgICAgICAgY29tbWl0KGNsb25lKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0cnVlOyAvLyBpZ25vcmUgb3RoZXIgc2V0IG9wZXJhdGlvbnNcbiAgICB9LFxuXG4gICAgaGFzKF90YXJnZXQsIHByb3ApIHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBnZXRDdXJyZW50KCk7XG4gICAgICByZXR1cm4gUmVmbGVjdC5oYXMoY3VycmVudCwgcHJvcCk7XG4gICAgfSxcblxuICAgIG93bktleXMoKSB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gZ2V0Q3VycmVudCgpO1xuICAgICAgcmV0dXJuIFJlZmxlY3Qub3duS2V5cyhjdXJyZW50KTtcbiAgICB9LFxuXG4gICAgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKF90YXJnZXQsIHByb3ApIHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBnZXRDdXJyZW50KCk7XG4gICAgICByZXR1cm4gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcihjdXJyZW50LCBwcm9wKTtcbiAgICB9LFxuICB9KTtcbn1cbiJdfQ==