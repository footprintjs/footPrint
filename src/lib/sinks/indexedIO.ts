import { createHash } from 'node:crypto';
import { close, constants, fstatSync, openSync, read } from 'node:fs';
import { getuid } from 'node:process';

import { checkSignal, IndexedRefusal } from './indexedAdmission.js';
import type { IndexedRecordUnknown } from './indexedTypes.js';

/** The path is a host capability, never a path constructed from a stored run or requested node. */
export function openIndexedDescriptor(path: string): number {
  if (typeof path !== 'string' || !path.length) throw new TypeError('openIndexedRecordFile: invalid path');
  return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
}

export function fileIdentity(fd: number): { readonly key: string; readonly size: number } {
  const stat = fstatSync(fd);
  const uid = typeof getuid === 'function' ? getuid() : undefined;
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0
  )
    throw new IndexedRefusal('unavailable');
  return { key: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]), size: stat.size };
}

export function assertIdentity(fd: number, key: string): void {
  if (fileIdentity(fd).key !== key) throw new IndexedRefusal('stale');
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Positional bytes only; exact short-read accounting is retained even when a later check refuses them. */
export async function readBytes(
  fd: number,
  offset: number,
  bytes: number,
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted?: () => void,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(bytes);
  let filled = 0;
  while (filled < bytes) {
    checkSignal(signal);
    const length = await new Promise<number>((resolve, reject) => {
      submitted?.();
      read(fd, buffer, filled, bytes - filled, offset + filled, (error, amount) => {
        if (error) reject(error);
        else resolve(amount);
      });
    });
    count(length);
    if (!length) throw new IndexedRefusal('stale');
    filled += length;
  }
  checkSignal(signal);
  return buffer;
}

export function closeDescriptor(fd: number): Promise<void> {
  return new Promise((resolve) => close(fd, () => resolve()));
}

/** A timeout bounds the wait, never frees an unfinished operation's file/slot. */
export async function boundedIndexedWork<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  settled: () => void,
): Promise<T | IndexedRecordUnknown> {
  if (signal?.aborted) {
    settled();
    return { status: 'unknown', reason: 'cancelled' };
  }
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let interrupt: (reason: IndexedRecordUnknown) => void = () => undefined;
  const interrupted = new Promise<IndexedRecordUnknown>((resolve) => (interrupt = resolve));
  const cancel = () => {
    controller.abort();
    interrupt({ status: 'unknown', reason: 'cancelled' });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    interrupt({ status: 'unknown', reason: 'timeout' });
  }, timeoutMs);
  const running = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value) => {
        if (performance.now() < deadline) return value;
        controller.abort();
        return { status: 'unknown', reason: 'timeout' } as const;
      },
      (error: unknown) => {
        if (performance.now() < deadline) throw error;
        controller.abort();
        return { status: 'unknown', reason: 'timeout' } as const;
      },
    );
  running.then(settled, settled);
  try {
    return await Promise.race([running, interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
