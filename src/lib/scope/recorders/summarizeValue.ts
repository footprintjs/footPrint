/**
 * summarizeValue — Human-readable summary of a scope value for narrative output.
 *
 * Shared by NarrativeRecorder and CombinedNarrativeRecorder to ensure consistent
 * narrative formatting. Truncates strings, summarizes arrays/objects by count.
 */

export function summarizeValue(value: unknown, maxLen: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length <= maxLen ? `"${value}"` : `"${value.slice(0, maxLen - 3)}..."`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `(${value.length} item${value.length > 1 ? 's' : ''})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const preview = keys.slice(0, 4).join(', ');
    const suffix = keys.length > 4 ? `, ... (${keys.length} keys)` : '';
    const result = `{${preview}${suffix}}`;
    return result.length <= maxLen ? result : `{${keys.length} keys}`;
  }
  return String(value);
}
