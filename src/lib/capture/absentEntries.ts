import { copyHistoryData, HistoryDataError } from './historyData.js';
import { ownData } from './noteShape.js';

// Event-key evidence only: ordinary optional metadata keeps JSON omission semantics.
const MAX_ABSENT_ENTRIES = 4096;
const MAX_PATH_SEGMENTS = 256;

const INDEX = /^(0|[1-9][0-9]*)$/;

/** `executionTree / <i> / (branches / <b> / <i>)* / stageReads|stageWrites / <key>` — the list form (12.0.0). */
function trackedPath(path: readonly string[]): boolean {
  if (path.length < 4 || path[0] !== 'executionTree' || !INDEX.test(path[1]!)) return false;
  let index = 2;
  while (index < path.length - 2) {
    if (path[index] === 'branches' && INDEX.test(path[index + 1] ?? '') && INDEX.test(path[index + 2] ?? ''))
      index += 3;
    else return false;
  }
  return index === path.length - 2 && (path[index] === 'stageReads' || path[index] === 'stageWrites');
}

/** Ordinal segment order, independent of locale and dotted business-key spellings. */
function comparePaths(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}

/** @internal Copy the served projection; charge sidecar growth before retaining each omitted event. */
export function copyCaptureEvidence(value: unknown, maxBytes: number): Record<string, unknown> {
  const absent: (readonly string[])[] = [];
  let bytes = 2;
  const encoder = new TextEncoder();
  const payload = copyHistoryData(value, maxBytes, {
    onOmitted: (path) => {
      if (!trackedPath(path)) return;
      if (path.length > MAX_PATH_SEGMENTS || absent.length >= MAX_ABSENT_ENTRIES)
        throw new HistoryDataError('too-large');
      const encoded = JSON.stringify(path);
      if (encoded.length > maxBytes - bytes) throw new HistoryDataError('too-large');
      bytes += encoder.encode(encoded).length + (absent.length ? 1 : 0);
      if (bytes > maxBytes) throw new HistoryDataError('too-large');
      absent.push(Object.freeze(path));
    },
  }) as Record<string, unknown>;
  if (!absent.length) return payload;
  absent.sort(comparePaths);
  // This second bounded copy charges the list and the rest of the evidence to one byte limit.
  return copyHistoryData({ ...payload, absent }, maxBytes) as Record<string, unknown>;
}

/**
 * @internal Validate already inert evidence. Never restores undefined into ordinary JSON maps.
 * A marker means an own undefined tracked value was omitted, not that business state lacked the key.
 */
export function validateAbsentEntries(payload: Record<string, unknown>): boolean {
  if (!Object.hasOwn(payload, 'absent')) return true;
  const absent = ownData(payload, 'absent');
  if (!Array.isArray(absent) || !absent.length || absent.length > MAX_ABSENT_ENTRIES) return false;
  let previous: readonly string[] | undefined;
  for (const path of absent) {
    if (
      !Array.isArray(path) ||
      path.length > MAX_PATH_SEGMENTS ||
      !path.every((segment) => typeof segment === 'string') ||
      !trackedPath(path)
    )
      return false;
    if (previous && comparePaths(previous, path) >= 0) return false;
    let node: unknown = payload;
    for (const segment of path.slice(0, -1)) {
      node = node && typeof node === 'object' ? Object.getOwnPropertyDescriptor(node, segment)?.value : undefined;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.hasOwn(node, path.at(-1)!)) return false;
    previous = path;
  }
  return true;
}
