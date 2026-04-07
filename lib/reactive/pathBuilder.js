"use strict";
/**
 * reactive/pathBuilder -- Write-path accumulator for nested set interception.
 *
 * When a user writes `scope.customer.address.zip = '90210'`, the nested Proxy
 * accumulates path segments ['address', 'zip']. This module converts that path
 * + value into a partial object suitable for updateValue():
 *
 *   buildNestedPatch(['address', 'zip'], '90210')
 *   => { address: { zip: '90210' } }
 *
 * The result is passed to `target.updateValue(rootKey, patch)` which does a
 * deep merge into the existing state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinPath = exports.buildNestedPatch = void 0;
/**
 * Converts a path segment array + leaf value into a nested partial object.
 *
 * @param segments - Path segments (e.g., ['address', 'zip'])
 * @param value - The leaf value to set
 * @returns Nested object (e.g., { address: { zip: '90210' } })
 *
 * Empty segments array returns the value itself (top-level assignment).
 */
function buildNestedPatch(segments, value) {
    let result = value;
    for (let i = segments.length - 1; i >= 0; i--) {
        result = { [segments[i]]: result };
    }
    return result;
}
exports.buildNestedPatch = buildNestedPatch;
/**
 * Joins path segments into a dot-notation string for recorder events.
 *
 * @param rootKey - The top-level key (e.g., 'customer')
 * @param segments - Nested path segments (e.g., ['address', 'zip'])
 * @returns Dot-path string (e.g., 'customer.address.zip')
 */
function joinPath(rootKey, segments) {
    if (segments.length === 0)
        return rootKey;
    return `${rootKey}.${segments.join('.')}`;
}
exports.joinPath = joinPath;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aEJ1aWxkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3JlYWN0aXZlL3BhdGhCdWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7O0dBWUc7OztBQUVIOzs7Ozs7OztHQVFHO0FBQ0gsU0FBZ0IsZ0JBQWdCLENBQUMsUUFBa0IsRUFBRSxLQUFjO0lBQ2pFLElBQUksTUFBTSxHQUFZLEtBQUssQ0FBQztJQUM1QixLQUFLLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUM5QyxNQUFNLEdBQUcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3JDLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBTkQsNENBTUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFnQixRQUFRLENBQUMsT0FBZSxFQUFFLFFBQWtCO0lBQzFELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxPQUFPLENBQUM7SUFDMUMsT0FBTyxHQUFHLE9BQU8sSUFBSSxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDNUMsQ0FBQztBQUhELDRCQUdDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiByZWFjdGl2ZS9wYXRoQnVpbGRlciAtLSBXcml0ZS1wYXRoIGFjY3VtdWxhdG9yIGZvciBuZXN0ZWQgc2V0IGludGVyY2VwdGlvbi5cbiAqXG4gKiBXaGVuIGEgdXNlciB3cml0ZXMgYHNjb3BlLmN1c3RvbWVyLmFkZHJlc3MuemlwID0gJzkwMjEwJ2AsIHRoZSBuZXN0ZWQgUHJveHlcbiAqIGFjY3VtdWxhdGVzIHBhdGggc2VnbWVudHMgWydhZGRyZXNzJywgJ3ppcCddLiBUaGlzIG1vZHVsZSBjb252ZXJ0cyB0aGF0IHBhdGhcbiAqICsgdmFsdWUgaW50byBhIHBhcnRpYWwgb2JqZWN0IHN1aXRhYmxlIGZvciB1cGRhdGVWYWx1ZSgpOlxuICpcbiAqICAgYnVpbGROZXN0ZWRQYXRjaChbJ2FkZHJlc3MnLCAnemlwJ10sICc5MDIxMCcpXG4gKiAgID0+IHsgYWRkcmVzczogeyB6aXA6ICc5MDIxMCcgfSB9XG4gKlxuICogVGhlIHJlc3VsdCBpcyBwYXNzZWQgdG8gYHRhcmdldC51cGRhdGVWYWx1ZShyb290S2V5LCBwYXRjaClgIHdoaWNoIGRvZXMgYVxuICogZGVlcCBtZXJnZSBpbnRvIHRoZSBleGlzdGluZyBzdGF0ZS5cbiAqL1xuXG4vKipcbiAqIENvbnZlcnRzIGEgcGF0aCBzZWdtZW50IGFycmF5ICsgbGVhZiB2YWx1ZSBpbnRvIGEgbmVzdGVkIHBhcnRpYWwgb2JqZWN0LlxuICpcbiAqIEBwYXJhbSBzZWdtZW50cyAtIFBhdGggc2VnbWVudHMgKGUuZy4sIFsnYWRkcmVzcycsICd6aXAnXSlcbiAqIEBwYXJhbSB2YWx1ZSAtIFRoZSBsZWFmIHZhbHVlIHRvIHNldFxuICogQHJldHVybnMgTmVzdGVkIG9iamVjdCAoZS5nLiwgeyBhZGRyZXNzOiB7IHppcDogJzkwMjEwJyB9IH0pXG4gKlxuICogRW1wdHkgc2VnbWVudHMgYXJyYXkgcmV0dXJucyB0aGUgdmFsdWUgaXRzZWxmICh0b3AtbGV2ZWwgYXNzaWdubWVudCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE5lc3RlZFBhdGNoKHNlZ21lbnRzOiBzdHJpbmdbXSwgdmFsdWU6IHVua25vd24pOiB1bmtub3duIHtcbiAgbGV0IHJlc3VsdDogdW5rbm93biA9IHZhbHVlO1xuICBmb3IgKGxldCBpID0gc2VnbWVudHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICByZXN1bHQgPSB7IFtzZWdtZW50c1tpXV06IHJlc3VsdCB9O1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogSm9pbnMgcGF0aCBzZWdtZW50cyBpbnRvIGEgZG90LW5vdGF0aW9uIHN0cmluZyBmb3IgcmVjb3JkZXIgZXZlbnRzLlxuICpcbiAqIEBwYXJhbSByb290S2V5IC0gVGhlIHRvcC1sZXZlbCBrZXkgKGUuZy4sICdjdXN0b21lcicpXG4gKiBAcGFyYW0gc2VnbWVudHMgLSBOZXN0ZWQgcGF0aCBzZWdtZW50cyAoZS5nLiwgWydhZGRyZXNzJywgJ3ppcCddKVxuICogQHJldHVybnMgRG90LXBhdGggc3RyaW5nIChlLmcuLCAnY3VzdG9tZXIuYWRkcmVzcy56aXAnKVxuICovXG5leHBvcnQgZnVuY3Rpb24gam9pblBhdGgocm9vdEtleTogc3RyaW5nLCBzZWdtZW50czogc3RyaW5nW10pOiBzdHJpbmcge1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gcm9vdEtleTtcbiAgcmV0dXJuIGAke3Jvb3RLZXl9LiR7c2VnbWVudHMuam9pbignLicpfWA7XG59XG4iXX0=