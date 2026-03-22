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
export function buildNestedPatch(segments: string[], value: unknown): unknown {
  let result: unknown = value;
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
export function joinPath(rootKey: string, segments: string[]): string {
  if (segments.length === 0) return rootKey;
  return `${rootKey}.${segments.join('.')}`;
}
