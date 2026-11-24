import { ownData } from '../capture/noteShape.js';
import { DEFAULT_FILE_SINK_MAX_ENTRY_BYTES } from './fileSink.js';
import { indexedAddress, IndexedRefusal, indexedText } from './indexedAdmission.js';
import { digest } from './indexedIO.js';
import {
  type PublishedRecordFile,
  type PublishedRecordIndex,
  type PublishedRecordRange,
  MAX_INDEX_BYTES,
  MAX_RANGES,
  MAX_ROWS,
} from './publishedRecordWriter.js';

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Copy the independent publication binding supplied by the authoritative host catalog. */
export function readPublication(value: PublishedRecordFile, audience: string): PublishedRecordFile {
  if (typeof audience !== 'string' || !audience.length || audience.length > 256)
    throw new IndexedRefusal('invalid-data');
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
  ) {
    throw new IndexedRefusal('invalid-data');
  }
  return { audience, payload: { key, size }, indexBytes, indexDigest };
}

/**
 * Admit the private directory against an independently resolved publication and a pinned payload.
 * The host authorizes its audience before calling. Selection still requires explicit scope admission.
 */
export function decodePublishedRecordIndex(
  bytes: Uint8Array,
  publication: PublishedRecordFile,
  payloadIdentity: PublishedRecordFile['payload'],
): PublishedRecordIndex {
  if (
    payloadIdentity.key !== publication.payload.key ||
    payloadIdentity.size !== publication.payload.size ||
    bytes.length !== publication.indexBytes
  ) {
    throw new IndexedRefusal('stale');
  }
  if (!integer(bytes.length, 1, MAX_INDEX_BYTES)) throw new IndexedRefusal('too-large');
  if (digest(bytes) !== publication.indexDigest) throw new IndexedRefusal('stale');
  let raw: unknown;
  try {
    raw = JSON.parse(indexedText(bytes));
  } catch {
    throw new IndexedRefusal('invalid-data');
  }
  const directory = ownData(raw, 'ranges');
  if (ownData(raw, 'version') !== 1 || !Array.isArray(directory) || directory.length > MAX_RANGES)
    throw new IndexedRefusal('invalid-data');
  const ranges: PublishedRecordRange[] = [];
  let nextRow = 0;
  let previousEnd = 0;
  for (let id = 0; id < directory.length; id++) {
    const row: unknown = directory[id];
    const [logRunId, drillPath] = JSON.parse(indexedAddress(ownData(row, 'address'))) as [string, string[]];
    const range = row as PublishedRecordRange;
    if (range.id !== id || range.firstRow !== nextRow || !integer(range.rowCount, 1, MAX_ROWS - nextRow))
      throw new IndexedRefusal('invalid-data');
    if (
      range.firstCommit === undefined
        ? range.lastCommit !== undefined
        : !integer(range.firstCommit, 0, Number.MAX_SAFE_INTEGER) ||
          !integer(range.lastCommit, range.firstCommit, Number.MAX_SAFE_INTEGER)
    ) {
      throw new IndexedRefusal('invalid-data');
    }
    if (range.closedThrough !== undefined && !integer(range.closedThrough, -1, Number.MAX_SAFE_INTEGER - 1))
      throw new IndexedRefusal('invalid-data');
    const position = {
      id,
      address: Object.freeze({ logRunId, drillPath: Object.freeze(drillPath) }),
      firstRow: nextRow,
      rowCount: range.rowCount,
      ...(range.firstCommit !== undefined && { firstCommit: range.firstCommit, lastCommit: range.lastCommit }),
      ...(range.closedThrough !== undefined && { closedThrough: range.closedThrough }),
    };
    if (range.status === 'written') {
      if (
        !integer(range.offset, previousEnd, payloadIdentity.size) ||
        !integer(range.bytes, 1, Math.min(DEFAULT_FILE_SINK_MAX_ENTRY_BYTES, payloadIdentity.size - range.offset)) ||
        !integer(range.maxLineBytes, 1, range.bytes) ||
        !sha256(range.digest)
      ) {
        throw new IndexedRefusal('invalid-data');
      }
      previousEnd = range.offset + range.bytes;
      ranges.push(
        Object.freeze({
          ...position,
          status: 'written',
          offset: range.offset,
          bytes: range.bytes,
          maxLineBytes: range.maxLineBytes,
          digest: range.digest,
        }),
      );
    } else {
      if (range.status !== 'omitted' || (range.reason !== 'unavailable' && range.reason !== 'too-large'))
        throw new IndexedRefusal('invalid-data');
      ranges.push(Object.freeze({ ...position, status: 'omitted', reason: range.reason }));
    }
    nextRow += range.rowCount;
  }
  return Object.freeze({ version: 1, ranges: Object.freeze(ranges) });
}
