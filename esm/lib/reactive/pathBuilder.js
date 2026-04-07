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
/**
 * Converts a path segment array + leaf value into a nested partial object.
 *
 * @param segments - Path segments (e.g., ['address', 'zip'])
 * @param value - The leaf value to set
 * @returns Nested object (e.g., { address: { zip: '90210' } })
 *
 * Empty segments array returns the value itself (top-level assignment).
 */
export function buildNestedPatch(segments, value) {
    let result = value;
    for (let i = segments.length - 1; i >= 0; i--) {
        result = { [segments[i]]: result };
    }
    return result;
}
/**
 * Joins path segments into a dot-notation string for recorder events.
 *
 * @param rootKey - The top-level key (e.g., 'customer')
 * @param segments - Nested path segments (e.g., ['address', 'zip'])
 * @returns Dot-path string (e.g., 'customer.address.zip')
 */
export function joinPath(rootKey, segments) {
    if (segments.length === 0)
        return rootKey;
    return `${rootKey}.${segments.join('.')}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aEJ1aWxkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3JlYWN0aXZlL3BhdGhCdWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7R0FZRztBQUVIOzs7Ozs7OztHQVFHO0FBQ0gsTUFBTSxVQUFVLGdCQUFnQixDQUFDLFFBQWtCLEVBQUUsS0FBYztJQUNqRSxJQUFJLE1BQU0sR0FBWSxLQUFLLENBQUM7SUFDNUIsS0FBSyxJQUFJLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDOUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUNyQyxDQUFDO0lBQ0QsT0FBTyxNQUFNLENBQUM7QUFDaEIsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSxRQUFRLENBQUMsT0FBZSxFQUFFLFFBQWtCO0lBQzFELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxPQUFPLENBQUM7SUFDMUMsT0FBTyxHQUFHLE9BQU8sSUFBSSxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDNUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogcmVhY3RpdmUvcGF0aEJ1aWxkZXIgLS0gV3JpdGUtcGF0aCBhY2N1bXVsYXRvciBmb3IgbmVzdGVkIHNldCBpbnRlcmNlcHRpb24uXG4gKlxuICogV2hlbiBhIHVzZXIgd3JpdGVzIGBzY29wZS5jdXN0b21lci5hZGRyZXNzLnppcCA9ICc5MDIxMCdgLCB0aGUgbmVzdGVkIFByb3h5XG4gKiBhY2N1bXVsYXRlcyBwYXRoIHNlZ21lbnRzIFsnYWRkcmVzcycsICd6aXAnXS4gVGhpcyBtb2R1bGUgY29udmVydHMgdGhhdCBwYXRoXG4gKiArIHZhbHVlIGludG8gYSBwYXJ0aWFsIG9iamVjdCBzdWl0YWJsZSBmb3IgdXBkYXRlVmFsdWUoKTpcbiAqXG4gKiAgIGJ1aWxkTmVzdGVkUGF0Y2goWydhZGRyZXNzJywgJ3ppcCddLCAnOTAyMTAnKVxuICogICA9PiB7IGFkZHJlc3M6IHsgemlwOiAnOTAyMTAnIH0gfVxuICpcbiAqIFRoZSByZXN1bHQgaXMgcGFzc2VkIHRvIGB0YXJnZXQudXBkYXRlVmFsdWUocm9vdEtleSwgcGF0Y2gpYCB3aGljaCBkb2VzIGFcbiAqIGRlZXAgbWVyZ2UgaW50byB0aGUgZXhpc3Rpbmcgc3RhdGUuXG4gKi9cblxuLyoqXG4gKiBDb252ZXJ0cyBhIHBhdGggc2VnbWVudCBhcnJheSArIGxlYWYgdmFsdWUgaW50byBhIG5lc3RlZCBwYXJ0aWFsIG9iamVjdC5cbiAqXG4gKiBAcGFyYW0gc2VnbWVudHMgLSBQYXRoIHNlZ21lbnRzIChlLmcuLCBbJ2FkZHJlc3MnLCAnemlwJ10pXG4gKiBAcGFyYW0gdmFsdWUgLSBUaGUgbGVhZiB2YWx1ZSB0byBzZXRcbiAqIEByZXR1cm5zIE5lc3RlZCBvYmplY3QgKGUuZy4sIHsgYWRkcmVzczogeyB6aXA6ICc5MDIxMCcgfSB9KVxuICpcbiAqIEVtcHR5IHNlZ21lbnRzIGFycmF5IHJldHVybnMgdGhlIHZhbHVlIGl0c2VsZiAodG9wLWxldmVsIGFzc2lnbm1lbnQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGROZXN0ZWRQYXRjaChzZWdtZW50czogc3RyaW5nW10sIHZhbHVlOiB1bmtub3duKTogdW5rbm93biB7XG4gIGxldCByZXN1bHQ6IHVua25vd24gPSB2YWx1ZTtcbiAgZm9yIChsZXQgaSA9IHNlZ21lbnRzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgcmVzdWx0ID0geyBbc2VnbWVudHNbaV1dOiByZXN1bHQgfTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEpvaW5zIHBhdGggc2VnbWVudHMgaW50byBhIGRvdC1ub3RhdGlvbiBzdHJpbmcgZm9yIHJlY29yZGVyIGV2ZW50cy5cbiAqXG4gKiBAcGFyYW0gcm9vdEtleSAtIFRoZSB0b3AtbGV2ZWwga2V5IChlLmcuLCAnY3VzdG9tZXInKVxuICogQHBhcmFtIHNlZ21lbnRzIC0gTmVzdGVkIHBhdGggc2VnbWVudHMgKGUuZy4sIFsnYWRkcmVzcycsICd6aXAnXSlcbiAqIEByZXR1cm5zIERvdC1wYXRoIHN0cmluZyAoZS5nLiwgJ2N1c3RvbWVyLmFkZHJlc3MuemlwJylcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvaW5QYXRoKHJvb3RLZXk6IHN0cmluZywgc2VnbWVudHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJvb3RLZXk7XG4gIHJldHVybiBgJHtyb290S2V5fS4ke3NlZ21lbnRzLmpvaW4oJy4nKX1gO1xufVxuIl19