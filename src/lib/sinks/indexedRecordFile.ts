import type { LogAddress } from 'foottrace';

import { ownData } from '../capture/noteShape.js';
import { checkSignal, indexedAddress, indexedLimits, IndexedRefusal, refused } from './indexedAdmission.js';
import {
  assertIdentity,
  boundedIndexedWork,
  closeDescriptor,
  digest,
  fileIdentity,
  openIndexedDescriptor,
  readBytes,
} from './indexedIO.js';
import { scanIndexedFile } from './indexedScan.js';
import type {
  IndexedLimits,
  IndexedRange,
  IndexedRecordFile,
  IndexedRecordFileOptions,
  IndexedRecordFileResult,
  IndexedRecordScope,
  IndexedRecordUnknown,
} from './indexedTypes.js';

/** Explicit bounded whole-file preparation, followed by authorized positional scope reads from that immutable file. */
export async function openIndexedRecordFile(
  path: string,
  options: IndexedRecordFileOptions,
): Promise<IndexedRecordFileResult> {
  const limits = indexedLimits(options);
  if (limits.signal?.aborted) return { status: 'unknown', reason: 'cancelled' };
  let fd: number;
  try {
    fd = openIndexedDescriptor(path);
  } catch {
    return { status: 'unknown', reason: 'unavailable' };
  }
  const stats = { preparationBytes: 0, scopeBytes: 0, readCalls: 0 };
  let prepared = false;
  let abandoned = false;
  let running = false;
  let closePromise: Promise<void> | undefined;
  const release = () => (closePromise ??= closeDescriptor(fd));
  try {
    const identity = fileIdentity(fd);
    running = true;
    const result = await boundedIndexedWork(
      (signal) => scanIndexedFile(fd, identity, limits, signal, (bytes) => (stats.preparationBytes += bytes)),
      limits.timeoutMs,
      limits.signal,
      () => {
        running = false;
        if (abandoned) release();
      },
    );
    if (!(result instanceof Map)) return result;
    prepared = true;
    return { status: 'ready', reader: indexedReader(fd, identity.key, result, limits, stats) };
  } catch (error) {
    return refused(error);
  } finally {
    if (!prepared) {
      abandoned = true;
      if (!running) await release();
    }
  }
}

function indexedReader(
  fd: number,
  identity: string,
  index: ReadonlyMap<string, readonly IndexedRange[]>,
  limits: IndexedLimits,
  stats: { preparationBytes: number; scopeBytes: number; readCalls: number },
): IndexedRecordFile {
  let closed = false;
  let active = false;
  let finishClose: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const release = () => {
    if (closed && !active) closeDescriptor(fd).then(() => finishClose?.());
  };
  return Object.freeze({
    get stats() {
      return Object.freeze({ ...stats });
    },
    async readScope(address: LogAddress, context?: { readonly signal?: AbortSignal }) {
      try {
        if (
          context !== undefined &&
          (!context ||
            Object.getPrototypeOf(context) !== Object.prototype ||
            (Object.getOwnPropertyDescriptor(context, 'signal') !== undefined &&
              !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(context, 'signal'), 'value')))
        )
          throw new IndexedRefusal('invalid-data');
        const signal = context === undefined ? undefined : (ownData(context, 'signal') as AbortSignal | undefined);
        if (signal !== undefined && !(signal instanceof AbortSignal)) throw new IndexedRefusal('invalid-data');
        if (signal?.aborted) throw new IndexedRefusal('cancelled');
        if (closed) throw new IndexedRefusal('closed');
        const key = indexedAddress(address);
        if (!limits.allowed.has(key)) throw new IndexedRefusal('not-permitted');
        if (active) throw new IndexedRefusal('busy');
        assertIdentity(fd, identity);
        const ranges = index.get(key);
        if (!ranges) throw new IndexedRefusal('no-match');
        active = true;
        return await boundedIndexedWork(
          (inner) =>
            loadIndexedScope(
              fd,
              identity,
              key,
              ranges,
              inner,
              (bytes) => (stats.scopeBytes += bytes),
              () => stats.readCalls++,
            ),
          limits.timeoutMs,
          signal,
          () => {
            active = false;
            release();
          },
        );
      } catch (error) {
        return refused(error);
      }
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = new Promise<void>((resolve) => (finishClose = resolve));
        release();
      }
      return closePromise;
    },
  });
}

async function loadIndexedScope(
  fd: number,
  identity: string,
  key: string,
  ranges: readonly IndexedRange[],
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted: () => void,
): Promise<IndexedRecordScope | IndexedRecordUnknown> {
  const entries: unknown[] = [];
  for (const range of ranges) {
    checkSignal(signal);
    const bytes = await readBytes(fd, range.offset, range.bytes, signal, count, submitted);
    if (digest(bytes) !== range.digest) throw new IndexedRefusal('stale');
    const entry: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (indexedAddress(ownData(entry, 'address')) !== key) throw new IndexedRefusal('invalid-data');
    entries.push(entry);
  }
  assertIdentity(fd, identity);
  checkSignal(signal);
  return { status: 'loaded', entries, bytesRead: ranges.reduce((total, range) => total + range.bytes, 0) };
}
