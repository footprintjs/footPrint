import { createHash } from 'node:crypto';
import { constants, fsync, openSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { getuid } from 'node:process';

import type { LogAddress } from 'foottrace';
import type { RecordEntry } from 'foottrace/write';

import {
  type FileSink,
  type FileSinkIndex,
  type FileSinkOptions,
  CLOSE_RESERVE_BYTES,
  createFileSink,
  DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS,
  DEFAULT_FILE_SINK_MAX_BYTES,
  DEFAULT_FILE_SINK_MAX_ENTRY_BYTES,
  DEFAULT_FILE_SINK_MAX_QUEUED_BYTES,
  withTimeout,
  writeAt,
} from './fileSink.js';
import { checkSignal, indexedAddress } from './indexedAdmission.js';
import { assertIdentity, closeDescriptor, digest, fileIdentity, readBytes } from './indexedIO.js';

export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_RANGES = 2048;
export const MAX_ROWS = 65_536;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const RANGE_TARGET_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export interface PublishedRecordFile {
  readonly audience: string;
  readonly payload: { readonly key: string; readonly size: number };
  readonly indexBytes: number;
  readonly indexDigest: string;
}

interface RangePosition {
  readonly id: number;
  readonly address: LogAddress;
  readonly firstRow: number;
  rowCount: number;
  firstCommit?: number;
  lastCommit?: number;
  closedThrough?: number;
}

type OmissionReason = 'too-large' | 'unavailable';

export type PublishedRecordRange = Readonly<RangePosition> &
  (
    | {
        readonly status: 'written';
        readonly offset: number;
        readonly bytes: number;
        readonly maxLineBytes: number;
        readonly digest: string;
      }
    | { readonly status: 'omitted'; readonly reason: OmissionReason }
  );

export interface PublishedRecordIndex {
  readonly version: 1;
  readonly ranges: readonly PublishedRecordRange[];
}

export interface IndexedFileSinkOptions extends FileSinkOptions {
  /** Record only entries already served for this audience. This sink does not authorize or redact entries. */
  readonly audience: string;
}

export interface IndexedFileSink extends FileSink {
  /** Permanently close the writer and create a fresh sidecar. Preserve the returned binding in a trusted catalog. */
  seal(indexPath: string): Promise<PublishedRecordFile>;
}

type Storage =
  | {
      readonly kind: 'written';
      readonly offset: number;
      bytes: number;
      maxLineBytes: number;
      readonly hash: ReturnType<typeof createHash>;
      damaged: boolean;
    }
  | { readonly kind: 'omitted'; readonly reason: OmissionReason };

interface PendingRange {
  readonly key: string;
  readonly position: RangePosition;
  readonly storage: Storage;
}

/** Reserve positions in producer order. A write callback can only mark the range it received as damaged. */
class PublishedRanges implements FileSinkIndex {
  private readonly ranges: PendingRange[] = [];
  private nextRow = 0;
  private indexBytes = '{"version":1,"ranges":[]}'.length;
  private failed = false;

  write(entry: RecordEntry, offset: number, bytes: Uint8Array): () => void {
    const range = this.place(entry, offset, bytes.length);
    const storage = range.storage;
    if (storage.kind !== 'written') throw new Error('indexedFileSink: missing written range');
    storage.bytes += bytes.length;
    storage.maxLineBytes = Math.max(storage.maxLineBytes, bytes.length);
    storage.hash.update(bytes);
    return () => {
      storage.damaged = true;
    };
  }

  omit(entry: RecordEntry, reason: OmissionReason): void {
    this.place(entry, 0, 0, reason);
  }

  private place(entry: RecordEntry, offset: number, bytes: number, reason?: OmissionReason): PendingRange {
    try {
      if (this.failed) throw new Error('indexedFileSink: incomplete directory');
      if (this.nextRow >= MAX_ROWS) throw new RangeError('indexedFileSink: row limit exceeded');
      const key = indexedAddress(entry.address);
      const commit = entry.kind === 'commit' ? positionOf(entry.bundle.idx) : undefined;
      const closedThrough = entry.kind === 'closed' ? positionOf(entry.commits) - 1 : undefined;
      let range = this.ranges.at(-1);
      if (!range || !canAppend(range, key, offset, bytes, reason)) {
        if (this.ranges.length >= MAX_RANGES) throw new RangeError('indexedFileSink: range limit exceeded');
        const [logRunId, drillPath] = JSON.parse(key) as [string, string[]];
        const position = {
          id: this.ranges.length,
          address: { logRunId, drillPath },
          firstRow: this.nextRow,
          rowCount: 0,
        };
        // Reserve every field to its maximum width so an oversized directory is refused before it accumulates.
        const descriptor: PublishedRecordRange = {
          ...position,
          rowCount: MAX_ROWS,
          firstCommit: Number.MAX_SAFE_INTEGER,
          lastCommit: Number.MAX_SAFE_INTEGER,
          closedThrough: Number.MAX_SAFE_INTEGER - 1,
          status: 'written',
          offset: MAX_PAYLOAD_BYTES,
          bytes: DEFAULT_FILE_SINK_MAX_ENTRY_BYTES,
          maxLineBytes: DEFAULT_FILE_SINK_MAX_ENTRY_BYTES,
          digest: '0'.repeat(64),
        };
        this.indexBytes += encoder.encode(JSON.stringify(descriptor)).length + 1;
        if (this.indexBytes > MAX_INDEX_BYTES) throw new RangeError('indexedFileSink: index byte limit exceeded');
        range = {
          key,
          position,
          storage:
            reason === undefined
              ? { kind: 'written', offset, bytes: 0, maxLineBytes: 0, hash: createHash('sha256'), damaged: false }
              : { kind: 'omitted', reason },
        };
        this.ranges.push(range);
      }
      const position = range.position;
      position.rowCount++;
      this.nextRow++;
      if (commit !== undefined) {
        position.firstCommit = Math.min(position.firstCommit ?? commit, commit);
        position.lastCommit = Math.max(position.lastCommit ?? commit, commit);
      }
      if (closedThrough !== undefined) position.closedThrough = closedThrough;
      return range;
    } catch (error) {
      // Once an attempted row cannot be represented, there is no directory we can truthfully publish.
      this.failed = true;
      throw error;
    }
  }

  async index(fd: number, size: number, signal: AbortSignal): Promise<PublishedRecordIndex> {
    if (this.failed) throw new Error('indexedFileSink: incomplete directory');
    const ranges: PublishedRecordRange[] = [];
    for (const { position, storage } of this.ranges) {
      checkSignal(signal);
      if (storage.kind === 'omitted') {
        ranges.push({ ...position, status: 'omitted', reason: storage.reason });
        continue;
      }
      const { offset, bytes, maxLineBytes } = storage;
      const expected = storage.hash.digest('hex');
      let verified = false;
      if (!storage.damaged && offset + bytes <= size) {
        try {
          const actual = await readBytes(fd, offset, bytes, signal, () => undefined);
          verified = digest(actual) === expected;
        } catch {
          checkSignal(signal);
        }
      }
      ranges.push(
        verified
          ? { ...position, status: 'written', offset, bytes, maxLineBytes, digest: expected }
          : { ...position, status: 'omitted', reason: 'unavailable' },
      );
    }
    return { version: 1, ranges };
  }
}

function canAppend(range: PendingRange, key: string, offset: number, bytes: number, reason?: OmissionReason): boolean {
  if (range.key !== key || range.position.closedThrough !== undefined) return false;
  const storage = range.storage;
  if (storage.kind === 'omitted') return reason === storage.reason;
  return (
    reason === undefined && offset === storage.offset + storage.bytes && storage.bytes + bytes <= RANGE_TARGET_BYTES
  );
}

function positionOf(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('indexedFileSink: invalid native record position');
  return value;
}

function writerOptions(options: IndexedFileSinkOptions): Required<IndexedFileSinkOptions> {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype)
    throw new TypeError('indexedFileSink: explicit audience required');
  const entries = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(entries)) {
    const descriptor = Reflect.get(entries, key);
    if (
      !Object.hasOwn(descriptor, 'value') ||
      !['audience', 'maxBytes', 'maxEntryBytes', 'maxQueuedBytes', 'flushTimeoutMs'].includes(String(key))
    )
      throw new TypeError('indexedFileSink: unsupported host option');
  }
  const audience: unknown = entries.audience?.value;
  if (typeof audience !== 'string' || !audience.length || audience.length > 256)
    throw new TypeError('indexedFileSink: explicit audience required');
  function limit(key: keyof FileSinkOptions, fallback: number, maximum: number): number {
    const value: unknown = entries[key]?.value;
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new RangeError('indexedFileSink: invalid host limit');
    return value;
  }
  return {
    audience,
    maxBytes: limit('maxBytes', DEFAULT_FILE_SINK_MAX_BYTES, MAX_PAYLOAD_BYTES - CLOSE_RESERVE_BYTES),
    maxEntryBytes: limit('maxEntryBytes', DEFAULT_FILE_SINK_MAX_ENTRY_BYTES, DEFAULT_FILE_SINK_MAX_ENTRY_BYTES),
    maxQueuedBytes: limit('maxQueuedBytes', DEFAULT_FILE_SINK_MAX_QUEUED_BYTES, MAX_PAYLOAD_BYTES),
    flushTimeoutMs: limit('flushTimeoutMs', DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS, 30_000),
  };
}

async function saveIndex(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  checkSignal(signal);
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await new Promise<void>((resolve, reject) => writeAt(fd, bytes, 0, (error) => (error ? reject(error) : resolve())));
    checkSignal(signal);
    await new Promise<void>((resolve, reject) => fsync(fd, (error) => (error ? reject(error) : resolve())));
    checkSignal(signal);
  } finally {
    await closeDescriptor(fd);
  }
}

/** Persist the new directory entries on hosts supporting POSIX directory fsync. */
async function syncParent(path: string, signal: AbortSignal): Promise<void> {
  if (typeof getuid !== 'function') return;
  checkSignal(signal);
  const fd = openSync(dirname(path), constants.O_RDONLY);
  try {
    await new Promise<void>((resolve, reject) => fsync(fd, (error) => (error ? reject(error) : resolve())));
    checkSignal(signal);
  } finally {
    await closeDescriptor(fd);
  }
}

/** Use the native file writer and an independently bound directory for one already-served audience. */
export function indexedFileSink(dataPath: string, options: IndexedFileSinkOptions): IndexedFileSink {
  const configured = writerOptions(options);
  const ranges = new PublishedRanges();
  const { sink, finalize } = createFileSink(dataPath, configured, ranges);
  let sealed: { readonly path: string; readonly publication: Promise<PublishedRecordFile> } | undefined;
  return Object.assign(sink, {
    seal(indexPath: string): Promise<PublishedRecordFile> {
      if (typeof indexPath !== 'string' || !indexPath.length)
        return Promise.reject(new TypeError('indexedFileSink: invalid sidecar path'));
      const path = resolvePath(indexPath);
      if (path === sink.path)
        return Promise.reject(new TypeError('indexedFileSink: payload and sidecar must have distinct paths'));
      if (sealed) {
        if (sealed.path === path) return sealed.publication;
        return Promise.reject(new Error('indexedFileSink: a sidecar was already selected'));
      }
      const controller = new AbortController();
      const signal = controller.signal;
      const work = finalize(async (fd) => {
        checkSignal(signal);
        const payload = Object.freeze(fileIdentity(fd));
        const index = await ranges.index(fd, payload.size, signal);
        assertIdentity(fd, payload.key);
        const bytes = encoder.encode(JSON.stringify(index));
        if (bytes.length > MAX_INDEX_BYTES) throw new RangeError('indexedFileSink: index byte limit exceeded');
        const indexDigest = digest(bytes);
        await saveIndex(path, bytes, signal);
        await syncParent(path, signal);
        if (dirname(path) !== dirname(sink.path)) await syncParent(sink.path, signal);
        assertIdentity(fd, payload.key);
        return Object.freeze({ audience: configured.audience, payload, indexBytes: bytes.length, indexDigest });
      });
      const publication = withTimeout(work, configured.flushTimeoutMs, 'indexedFileSink: seal timed out', () =>
        controller.abort(),
      );
      sealed = { path, publication };
      return publication;
    },
  });
}
