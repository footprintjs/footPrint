import { ownData } from '../capture/noteShape.js';
import { checkSignal, indexedAddress, IndexedRefusal } from './indexedAdmission.js';
import { assertIdentity, digest, readBytes } from './indexedIO.js';
import type { IndexedLimits, IndexedRange } from './indexedTypes.js';

/** One whole-file preparation pass. Only authorized range metadata is retained, never the archive's values. */
export async function scanIndexedFile(
  fd: number,
  identity: { readonly key: string; readonly size: number },
  limits: IndexedLimits,
  signal: AbortSignal,
  count: (bytes: number) => void,
): Promise<Map<string, readonly IndexedRange[]>> {
  if (identity.size > limits.maxBytes) throw new IndexedRefusal('too-large');
  const index = new Map<string, IndexedRange[]>();
  const totals = new Map<string, number>();
  let entries = 0;
  let lineStart = 0;
  let pieces: Uint8Array[] = [];
  let lineBytes = 0;
  const append = (piece: Uint8Array) => {
    lineBytes += piece.length;
    if (lineBytes > limits.maxEntryBytes) throw new IndexedRefusal('too-large');
    if (piece.length) pieces.push(piece);
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let position = 0; position < identity.size; ) {
    checkSignal(signal);
    const chunk = await readBytes(fd, position, Math.min(65536, identity.size - position), signal, count);
    position += chunk.length;
    let start = 0;
    for (let end = 0; end < chunk.length; end++) {
      if (chunk[end] !== 10) continue;
      append(chunk.subarray(start, end + 1));
      // Assemble once at the delimiter, rather than repeatedly copying a growing partial line.
      const bytes = new Uint8Array(lineBytes);
      let filled = 0;
      for (const piece of pieces) {
        bytes.set(piece, filled);
        filled += piece.length;
      }
      const text = decoder.decode(bytes);
      if (text.trim()) {
        if (++entries > limits.maxEntries) throw new IndexedRefusal('too-large');
        let row: unknown;
        try {
          row = JSON.parse(text);
        } catch {
          throw new IndexedRefusal('invalid-data');
        }
        const scope = indexedAddress(ownData(row, 'address'));
        if (limits.allowed.has(scope)) {
          const total = (totals.get(scope) ?? 0) + bytes.length;
          if (total > limits.maxScopeBytes) throw new IndexedRefusal('too-large');
          totals.set(scope, total);
          const ranges = index.get(scope) ?? [];
          ranges.push({ offset: lineStart, bytes: bytes.length, digest: digest(bytes) });
          index.set(scope, ranges);
        }
      }
      lineStart += bytes.length;
      pieces = [];
      lineBytes = 0;
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  if (lineBytes) throw new IndexedRefusal('invalid-data'); // a torn tail never becomes an absent event
  assertIdentity(fd, identity.key);
  checkSignal(signal);
  return index;
}
