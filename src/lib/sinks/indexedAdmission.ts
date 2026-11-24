import { ownData } from '../capture/noteShape.js';
import type { IndexedLimits, IndexedRecordFileOptions, IndexedRecordFileReason } from './indexedTypes.js';

export class IndexedRefusal extends Error {
  constructor(readonly reason: IndexedRecordFileReason) {
    super('indexed record file: evidence unavailable');
  }
}

export function invalidIndexedData(): never {
  throw new IndexedRefusal('invalid-data');
}

export function validIndexedAudience(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export const MAX_PUBLISHED_VIEW_BYTES = 16 * 1024 * 1024;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A stored line's text. Bytes that are not UTF-8 are corrupt data (`'invalid-data'`), never an I/O problem. */
export function indexedText(bytes: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    invalidIndexedData();
  }
}

/** An index key, not a source-ID or record codec. Canonical record admission remains in Foottrace. */
export function indexedAddress(value: unknown): string {
  const run = ownData(value, 'logRunId');
  const path = ownData(value, 'drillPath');
  if (typeof run !== 'string' || !run.length || run.length > 2048 || !Array.isArray(path)) invalidIndexedData();
  const length = Object.getOwnPropertyDescriptor(path, 'length')?.value;
  if (Object.getPrototypeOf(path) !== Array.prototype || !Number.isSafeInteger(length) || length > 64)
    invalidIndexedData();
  const segments: string[] = [];
  for (let index = 0; index < length; index++) {
    const segment = Object.getOwnPropertyDescriptor(path, String(index))?.value;
    if (typeof segment !== 'string' || !segment.length || segment.length > 2048) invalidIndexedData();
    segments.push(segment);
  }
  return JSON.stringify([run, segments]);
}

function limit(options: unknown, name: string, fallback: number, maximum: number): number {
  const configured = ownData(options, name);
  const value = configured === undefined ? fallback : configured;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError('openIndexedRecordFile: invalid host limits');
  return value;
}

export function indexedLimits(options: IndexedRecordFileOptions, published = false): IndexedLimits {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype)
    throw new TypeError('openIndexedRecordFile: explicit host authorization required');
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
      throw new TypeError('openIndexedRecordFile: options must be plain data');
    if (published && key === 'audience') continue;
    if (
      typeof key !== 'string' ||
      !['allowedScopes', 'maxBytes', 'maxEntryBytes', 'maxEntries', 'maxScopeBytes', 'timeoutMs', 'signal'].includes(
        key,
      )
    )
      throw new TypeError('openIndexedRecordFile: unsupported host option');
  }
  const scopes = ownData(options, 'allowedScopes');
  if (!Array.isArray(scopes) || Object.getPrototypeOf(scopes) !== Array.prototype || scopes.length > 256)
    throw new TypeError('openIndexedRecordFile: explicit host authorization required');
  const allowed = new Set<string>();
  try {
    for (let index = 0; index < scopes.length; index++)
      allowed.add(indexedAddress(Object.getOwnPropertyDescriptor(scopes, String(index))?.value));
  } catch {
    throw new TypeError('openIndexedRecordFile: invalid authorized scope');
  }
  const signal = ownData(options, 'signal') as AbortSignal | undefined;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('openIndexedRecordFile: invalid cancellation signal');
  const maxScopeBytes = limit(
    options,
    'maxScopeBytes',
    published ? MAX_PUBLISHED_VIEW_BYTES : 8 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  if (published && maxScopeBytes > MAX_PUBLISHED_VIEW_BYTES)
    throw new TypeError('openPublishedRecordFile: selected scope exceeds the view limit');
  return {
    allowed,
    maxBytes: limit(options, 'maxBytes', 64 * 1024 * 1024, 256 * 1024 * 1024),
    maxEntryBytes: limit(options, 'maxEntryBytes', 8 * 1024 * 1024, 8 * 1024 * 1024),
    maxEntries: limit(options, 'maxEntries', 16384, 65536),
    maxScopeBytes,
    timeoutMs: limit(options, 'timeoutMs', 10000, 30000),
    ...(signal && { signal }),
  };
}

export function refused(error: unknown): { readonly status: 'unknown'; readonly reason: IndexedRecordFileReason } {
  return { status: 'unknown', reason: error instanceof IndexedRefusal ? error.reason : 'unavailable' };
}

/** Filesystem errors and rejected bytes are never interpolated into a served reason. */
export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new IndexedRefusal('cancelled');
}
