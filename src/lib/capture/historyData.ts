/** @internal Fixed diagnostic only; never carries source values, paths or adapter errors. */
export class HistoryDataError extends Error {
  constructor(readonly code: 'too-large' | 'invalid-data' | 'source-validation-limit') {
    super(code === 'too-large' ? 'Capture history data too large' : 'Capture history data refused');
  }
}

/** Fixed boundary reasons; no untrusted error text leaves the engine. */
export function historyFailureReason(error: unknown, boundary: 'evidence' | 'history'): string {
  if (error instanceof HistoryDataError) {
    if (error.code === 'source-validation-limit') return 'source-validation-limit';
    if (error.code === 'too-large') return `${boundary}-too-large`;
  }
  return `${boundary}-refused`;
}

/** @internal Copy bounded inert JSON data without invoking accessors, toJSON or application coercion. */
export function copyHistoryData(
  value: unknown,
  maxBytes: number,
  onOmitted?: (path: readonly string[]) => void,
): unknown {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const charge = (text: string): void => {
    if (text.length > maxBytes - bytes) throw new HistoryDataError('too-large');
    bytes += encoder.encode(text).length;
    if (bytes > maxBytes) throw new HistoryDataError('too-large');
  };
  const copy = (item: unknown, depth: number, path: string[]): unknown => {
    if (++nodes > 100_000 || depth > 256) throw new HistoryDataError('invalid-data');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)))
        throw new HistoryDataError('invalid-data');
      charge(JSON.stringify(item));
      return item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new HistoryDataError('invalid-data');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype))
      throw new HistoryDataError('invalid-data');
    ancestors.add(item);
    charge(array ? '[]' : '{}');
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Object.keys(item);
    if (keys.length > 100_000 - nodes) throw new HistoryDataError('invalid-data');
    // Arrays must be dense JSON arrays without extra properties. No silent dropping of holes or expandos.
    if (array && Object.getOwnPropertyDescriptor(item, 'length')?.value !== keys.length)
      throw new HistoryDataError('invalid-data');
    let written = 0;
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !Object.hasOwn(property, 'value')) throw new HistoryDataError('invalid-data');
      if (array && key !== String(written)) throw new HistoryDataError('invalid-data');
      // Ordinary JSON object omission. Arrays/root undefined remain refused; no snapshot-field allow-list.
      if (property.value === undefined && !array) {
        onOmitted?.([...path, key]);
        continue;
      }
      if (written++) charge(',');
      if (!array) charge(JSON.stringify(key) + ':');
      Object.defineProperty(output, key, {
        value: copy(property.value, depth + 1, [...path, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(item);
    return Object.freeze(output);
  };
  return copy(value, 0, []);
}

/** @internal Integrity of this JSON representation, not a value fingerprint or an authenticity signature. */
export async function historyDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

/** One field order for both sides of the evidence digest; optional source/absence fields cannot drift. */
export function historyEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const fields = ['capture', 'executionTree', 'recorders', 'readSources', 'absent'];
  if (Object.keys(value).some((key) => key !== 'target' && !fields.includes(key)))
    throw new HistoryDataError('invalid-data');
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
