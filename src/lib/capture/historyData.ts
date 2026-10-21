/** @internal Copy bounded inert JSON data without invoking accessors, toJSON or application coercion. */
export function copyHistoryData(value: unknown, maxBytes: number, optionalSnapshotFields = false): unknown {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const charge = (text: string): void => {
    if (text.length > maxBytes - bytes) throw new Error('Capture history data refused');
    bytes += encoder.encode(text).length;
    if (bytes > maxBytes) throw new Error('Capture history data refused');
  };
  const copy = (item: unknown, depth: number, path: string[]): unknown => {
    if (++nodes > 100_000 || depth > 256) throw new Error('Capture history data refused');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)))
        throw new Error('Capture history data refused');
      charge(JSON.stringify(item));
      return item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('Capture history data refused');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype))
      throw new Error('Capture history data refused');
    ancestors.add(item);
    charge(array ? '[]' : '{}');
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Object.keys(item);
    if (keys.length > 100_000 - nodes) throw new Error('Capture history data refused');
    // Arrays must be dense JSON arrays without extra properties. No silent dropping of holes or expandos.
    if (array && Object.getOwnPropertyDescriptor(item, 'length')?.value !== keys.length)
      throw new Error('Capture history data refused');
    let written = 0;
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !Object.hasOwn(property, 'value')) throw new Error('Capture history data refused');
      if (array && key !== String(written)) throw new Error('Capture history data refused');
      // Optional object fields use the existing JSON representation; absent array values are a loss.
      const location = path.join('.');
      const optional =
        optionalSnapshotFields &&
        ((/^executionTree(?:(?:\.next)|(?:\.children\.\d+))*$/.test(location) &&
          ['runtimeStageId', 'name'].includes(key)) ||
          (/^recorders\.\d+$/.test(location) && ['description', 'preferredOperation', 'meta'].includes(key)));
      if (property.value === undefined && !array && optional) continue;
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

/** @internal Own data only. Shared by producer receipt checks and saved engine-metadata admission. */
export function historyData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
