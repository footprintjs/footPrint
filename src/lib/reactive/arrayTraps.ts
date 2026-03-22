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
export function createArrayProxy<T>(getCurrent: () => T[], commit: (newArray: T[]) => void): T[] {
  // Use the actual current array as the Proxy target. Node.js console.log
  // inspects the target directly (bypasses Proxy traps). By using the real
  // array, console.log shows correct values. The target reference is fixed
  // at creation time — after mutations, the proxy returns a new proxy
  // (via cache invalidation) with the fresh array as target.
  const target = getCurrent() as T[];

  return new Proxy(target, {
    get(_target, prop, receiver) {
      // Intercept mutating methods
      if (typeof prop === 'string' && MUTATING_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const clone = [...getCurrent()];
          const result = (clone as any)[prop](...args);
          commit(clone);
          return result;
        };
      }

      // Non-mutating access: delegate to the current array snapshot
      const current = getCurrent();

      // 'length' and index access
      if (prop === 'length') return current.length;

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
        const val = (current as any)[prop];
        if (typeof val === 'function') return val.bind(current);
        return val;
      }

      // All other methods (map, filter, forEach, find, etc.) -- bind to current
      const val = (current as any)[prop];
      if (typeof val === 'function') return val.bind(current);
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
