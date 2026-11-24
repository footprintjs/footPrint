import { CommitRangeIndex } from 'foottrace';

import { ownData } from '../capture/noteShape.js';
import { DEFAULT_FILE_SINK_MAX_ENTRY_BYTES } from './fileSink.js';
import { indexedAddress, indexedLimits, IndexedRefusal, indexedText } from './indexedAdmission.js';
import {
  assertIdentity,
  closeDescriptor,
  digest,
  fileIdentity,
  openIndexedDescriptor,
  readBytes,
} from './indexedIO.js';
import type { IndexedFileIdentity, IndexedReadStats } from './indexedSession.js';
import type { IndexedLimits, IndexedRecordFileOptions } from './indexedTypes.js';
import {
  type PublishedRecordFile,
  type PublishedRecordRange,
  MAX_INDEX_BYTES,
  MAX_RANGES,
  MAX_ROWS,
} from './publishedRecordWriter.js';

const MAX_VIEW_BYTES = 16 * 1024 * 1024;

export interface PublishedRecordFileOptions extends IndexedRecordFileOptions {
  /** The audience selected by the trusted host for this request. */
  readonly audience: string;
}

export interface PublishedScope {
  readonly ranges: readonly PublishedRecordRange[];
  readonly commits: CommitRangeIndex<number>;
}

const validAudience = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function publishedLimits(options: PublishedRecordFileOptions): IndexedLimits & { readonly audience: string } {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype)
    throw new TypeError('openPublishedRecordFile: explicit host authorization required');
  const audience = ownData(options, 'audience');
  if (!validAudience(audience)) throw new TypeError('openPublishedRecordFile: explicit audience required');
  const indexedOptions = Object.fromEntries(
    Reflect.ownKeys(options)
      .filter((key) => key !== 'audience')
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
          throw new TypeError('openPublishedRecordFile: options must be plain data');
        return [key, descriptor.value];
      }),
  );
  if (indexedOptions.maxScopeBytes === undefined) indexedOptions.maxScopeBytes = MAX_VIEW_BYTES;
  return { ...indexedLimits(indexedOptions as unknown as IndexedRecordFileOptions), audience };
}

export function readPublication(value: PublishedRecordFile, audience: string): PublishedRecordFile {
  if (ownData(value, 'audience') !== audience) throw new IndexedRefusal('not-permitted');
  const payload = ownData(value, 'payload');
  const key = ownData(payload, 'key');
  const size = ownData(payload, 'size');
  const indexBytes = ownData(value, 'indexBytes');
  const indexDigest = ownData(value, 'indexDigest');
  if (
    typeof key !== 'string' ||
    !key.length ||
    key.length > 1024 ||
    !integer(size, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(indexBytes, 1, MAX_INDEX_BYTES) ||
    !sha256(indexDigest)
  )
    throw new IndexedRefusal('invalid-data');
  return { audience, payload: { key, size }, indexBytes, indexDigest };
}

export async function readPublishedIndex(
  path: string,
  identity: IndexedFileIdentity,
  publication: PublishedRecordFile,
  limits: IndexedLimits,
  signal: AbortSignal,
  stats: IndexedReadStats,
): Promise<Map<string, PublishedScope>> {
  if (identity.size > limits.maxBytes) throw new IndexedRefusal('too-large');
  if (identity.key !== publication.payload.key || identity.size !== publication.payload.size)
    throw new IndexedRefusal('stale');
  const fd = openIndexedDescriptor(path);
  try {
    const indexIdentity = fileIdentity(fd);
    if (indexIdentity.size !== publication.indexBytes) throw new IndexedRefusal('stale');
    const data = await readBytes(fd, 0, indexIdentity.size, signal, (bytes) => (stats.preparationBytes += bytes));
    assertIdentity(fd, indexIdentity.key);
    if (digest(data) !== publication.indexDigest) throw new IndexedRefusal('stale');
    return admitDirectory(JSON.parse(indexedText(data)), identity.size, limits.allowed);
  } finally {
    await closeDescriptor(fd);
  }
}

function admitDirectory(
  value: unknown,
  payloadBytes: number,
  allowed: ReadonlySet<string>,
): Map<string, PublishedScope> {
  const ranges = ownData(value, 'ranges');
  if (ownData(value, 'version') !== 1 || !Array.isArray(ranges) || ranges.length > MAX_RANGES)
    throw new IndexedRefusal('invalid-data');
  const scopes = new Map<string, { ranges: PublishedRecordRange[]; commits: CommitRangeIndex<number> }>();
  let nextRow = 0;
  let previousEnd = 0;
  for (let id = 0; id < ranges.length; id++) {
    const row: unknown = ranges[id];
    const scope = indexedAddress(ownData(row, 'address'));
    const range = row as PublishedRecordRange;
    if (range.id !== id || range.firstRow !== nextRow || !integer(range.rowCount, 1, MAX_ROWS - nextRow))
      throw new IndexedRefusal('invalid-data');
    if (
      range.firstCommit === undefined
        ? range.lastCommit !== undefined
        : !integer(range.firstCommit, 0, Number.MAX_SAFE_INTEGER) ||
          !integer(range.lastCommit, range.firstCommit, Number.MAX_SAFE_INTEGER)
    )
      throw new IndexedRefusal('invalid-data');
    if (range.closedThrough !== undefined && !integer(range.closedThrough, -1, Number.MAX_SAFE_INTEGER - 1))
      throw new IndexedRefusal('invalid-data');
    if (range.status === 'written') {
      if (
        !integer(range.offset, previousEnd, payloadBytes) ||
        !integer(range.bytes, 1, Math.min(DEFAULT_FILE_SINK_MAX_ENTRY_BYTES, payloadBytes - range.offset)) ||
        !integer(range.maxLineBytes, 1, range.bytes) ||
        !sha256(range.digest)
      )
        throw new IndexedRefusal('invalid-data');
      previousEnd = range.offset + range.bytes;
    } else if (range.status !== 'omitted' || (range.reason !== 'unavailable' && range.reason !== 'too-large')) {
      throw new IndexedRefusal('invalid-data');
    }
    nextRow += range.rowCount;
    if (!allowed.has(scope)) continue;
    const directory = scopes.get(scope) ?? { ranges: [], commits: new CommitRangeIndex<number>() };
    const slot = directory.ranges.length;
    directory.ranges.push(range);
    if (range.firstCommit !== undefined && range.lastCommit !== undefined)
      directory.commits.close(directory.commits.open(slot, range.firstCommit), range.lastCommit);
    scopes.set(scope, directory);
  }
  return scopes;
}

/** Include the opening, commit prefix and eligible native closes in original producer order. */
export function prefixRanges(scope: PublishedScope, target: number): readonly PublishedRecordRange[] {
  let end = 0;
  if (target >= 0) {
    for (const commit of scope.commits.overlapping(0, target)) end = Math.max(end, commit.label);
  }
  const ranges = scope.ranges;
  for (let i = end + 1; i < ranges.length; i++) {
    const row = ranges[i];
    if (row.firstCommit !== undefined && row.firstCommit > target) break;
    if (row.closedThrough !== undefined && row.closedThrough <= target) end = i;
  }
  return ranges.slice(0, end + 1);
}
