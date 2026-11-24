import type { LogAddress } from 'foottrace';

import { ownData } from '../capture/noteShape.js';
import { indexedAddress, IndexedRefusal, refused } from './indexedAdmission.js';
import {
  assertIdentity,
  boundedIndexedWork,
  closeDescriptor,
  fileIdentity,
  openIndexedDescriptor,
} from './indexedIO.js';
import type { IndexedLimits, IndexedRecordUnknown } from './indexedTypes.js';

export type IndexedFileIdentity = ReturnType<typeof fileIdentity>;
export type IndexedReadStats = { preparationBytes: number; scopeBytes: number; readCalls: number };
export type IndexedReadContext = { readonly signal?: AbortSignal };

function readSignal(context: IndexedReadContext | undefined): AbortSignal | undefined {
  if (context === undefined) return undefined;
  if (!context || Object.getPrototypeOf(context) !== Object.prototype) throw new IndexedRefusal('invalid-data');
  const descriptor = Object.getOwnPropertyDescriptor(context, 'signal');
  if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
    throw new IndexedRefusal('invalid-data');
  const signal = ownData(context, 'signal');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new IndexedRefusal('invalid-data');
  return signal;
}

/** Own one payload descriptor during preparation, reads, cancellation and close. */
export async function openIndexedSession<T, R>(
  path: string,
  limits: IndexedLimits,
  prepare: (fd: number, identity: IndexedFileIdentity, signal: AbortSignal, stats: IndexedReadStats) => Promise<T>,
  reader: (fd: number, identity: string, prepared: T, session: ReturnType<typeof indexedSession>) => R,
): Promise<{ readonly status: 'ready'; readonly reader: R } | IndexedRecordUnknown> {
  if (limits.signal?.aborted) return { status: 'unknown', reason: 'cancelled' };
  let fd: number;
  try {
    fd = openIndexedDescriptor(path);
  } catch {
    return { status: 'unknown', reason: 'unavailable' };
  }
  const stats = { preparationBytes: 0, scopeBytes: 0, readCalls: 0 };
  let ready = false;
  let abandoned = false;
  let running = false;
  let closePromise: Promise<void> | undefined;
  const release = () => (closePromise ??= closeDescriptor(fd));
  try {
    const identity = fileIdentity(fd);
    running = true;
    const result = await boundedIndexedWork(
      async (signal) => ({ status: 'prepared' as const, value: await prepare(fd, identity, signal, stats) }),
      limits.timeoutMs,
      limits.signal,
      () => {
        running = false;
        if (abandoned) release();
      },
    );
    if (result.status !== 'prepared') return result;
    const opened = reader(fd, identity.key, result.value, indexedSession(fd, identity.key, limits, stats));
    ready = true;
    return { status: 'ready', reader: opened };
  } catch (error) {
    return refused(error);
  } finally {
    if (!ready) {
      abandoned = true;
      if (!running) await release();
    }
  }
}

function indexedSession(fd: number, identity: string, limits: IndexedLimits, stats: IndexedReadStats) {
  let closed = false;
  let active = false;
  let finishClose: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const release = () => {
    if (closed && !active) closeDescriptor(fd).then(() => finishClose?.());
  };
  return {
    stats: () => Object.freeze({ ...stats }),
    count: (bytes: number) => (stats.scopeBytes += bytes),
    submitted: () => stats.readCalls++,
    async read<T>(
      address: LogAddress,
      context: IndexedReadContext | undefined,
      work: (key: string, signal: AbortSignal) => Promise<T>,
    ): Promise<T | IndexedRecordUnknown> {
      try {
        const signal = readSignal(context);
        if (signal?.aborted) throw new IndexedRefusal('cancelled');
        if (closed) throw new IndexedRefusal('closed');
        const key = indexedAddress(address);
        if (!limits.allowed.has(key)) throw new IndexedRefusal('not-permitted');
        if (active) throw new IndexedRefusal('busy');
        assertIdentity(fd, identity);
        active = true;
        return await boundedIndexedWork(
          (inner) => work(key, inner),
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
  };
}
