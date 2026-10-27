import { close, openSync, read, rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openIndexedRecordFile } from '../../../../src/sinks.js';
import {
  indexedAddress,
  indexedFixture,
  indexedReady,
  indexedRows,
  indexedText,
} from '../../../helpers/indexedRecordFile.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, read: vi.fn(actual.read), close: vi.fn(actual.close), openSync: vi.fn(actual.openSync) };
});
const actualRead = vi.mocked(read).getMockImplementation()!;
const dirs: string[] = [];
const fixture = () => {
  const file = indexedFixture();
  dirs.push(file.dir);
  return file;
};
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(read).mockImplementation(actualRead).mockClear();
  vi.mocked(close).mockClear();
  vi.mocked(openSync).mockClear();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function holdNextRead() {
  let release: () => void = () => {
    throw Error('not started');
  };
  let started: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (started = resolve));
  vi.mocked(read).mockImplementationOnce(((...args: any[]) => {
    release = () => (actualRead as any)(...args);
    started();
  }) as any);
  return { ready, release: () => release() };
}

describe('indexed file bounds and descriptor lifecycle', () => {
  it('counts a submitted scope read even when its callback fails without bytes', async () => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    vi.mocked(read)
      .mockClear()
      .mockImplementationOnce(((
        _fd: number,
        _buffer: Uint8Array,
        _offset: number,
        _length: number,
        _position: number,
        callback: (error: Error, read: number) => void,
      ) => {
        callback(new Error('PRIVATE_READ_ERROR'), 0);
      }) as any);
    try {
      expect(await reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'unavailable' });
      expect(read).toHaveBeenCalledTimes(1);
      expect(reader.stats.readCalls).toBe(1);
      expect(reader.stats.scopeBytes).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it('counts every short-read submission once and only the bytes each callback returns', async () => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    vi.mocked(read)
      .mockClear()
      .mockImplementation(((
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
        callback: unknown,
      ) => {
        (actualRead as any)(fd, buffer, offset, Math.min(length, 7), position, callback);
      }) as any);
    try {
      const loaded = await reader.readScope(indexedAddress());
      expect(loaded.status).toBe('loaded');
      expect(vi.mocked(read).mock.calls.length).toBeGreaterThan(2);
      expect(reader.stats.readCalls).toBe(vi.mocked(read).mock.calls.length);
      if (loaded.status === 'loaded') expect(reader.stats.scopeBytes).toBe(loaded.bytesRead);
    } finally {
      await reader.close();
    }
  });

  it.each(['maxBytes', 'maxEntryBytes', 'maxEntries', 'maxScopeBytes', 'timeoutMs'])(
    'refuses bad %s before opening or reading',
    async (option) => {
      const file = fixture();
      for (const value of [0, -1, 0.5, null, Infinity, Number.MAX_SAFE_INTEGER]) {
        await expect(
          openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()], [option]: value } as any),
        ).rejects.toThrow('host limits');
      }
      expect(openSync).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(['maxBytes', 'maxEntryBytes', 'maxEntries', 'maxScopeBytes'])(
    'does not return a partial index after %s exhaustion',
    async (option) => {
      const file = fixture();
      expect(await openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()], [option]: 1 })).toEqual({
        status: 'unknown',
        reason: 'too-large',
      });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts exact byte and entry ceilings', async () => {
    const file = fixture();
    const rows = indexedRows();
    const text = indexedText(rows);
    const opened = await openIndexedRecordFile(file.path, {
      allowedScopes: [indexedAddress()],
      maxBytes: Buffer.byteLength(text),
      maxScopeBytes: Buffer.byteLength(text),
      maxEntries: rows.length,
      maxEntryBytes: Math.max(...rows.map((row) => Buffer.byteLength(JSON.stringify(row) + '\n'))),
    });
    expect(opened.status).toBe('ready');
    if (opened.status === 'ready') await opened.reader.close();
  });

  it('does not infer healthy absence from an authorized scope missing from an empty file', async () => {
    const file = fixture();
    writeFileSync(file.path, '');
    const reader = await indexedReady(file.path);
    try {
      expect(await reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'no-match' });
      expect(reader.stats.scopeBytes).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it('checks cancellation before preparation opens a descriptor and before selected reads', async () => {
    const file = fixture();
    const controller = new AbortController();
    controller.abort('PRIVATE');
    expect(
      await openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()], signal: controller.signal }),
    ).toEqual({ status: 'unknown', reason: 'cancelled' });
    expect(openSync).not.toHaveBeenCalled();
    const reader = await indexedReady(file.path);
    vi.mocked(read).mockClear();
    try {
      expect(await reader.readScope(indexedAddress(), { signal: controller.signal })).toEqual({
        status: 'unknown',
        reason: 'cancelled',
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await reader.close();
    }
  });

  it('keeps successful preparation open until explicit idempotent close', async () => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    expect(close).not.toHaveBeenCalled();
    expect((await reader.readScope(indexedAddress())).status).toBe('loaded');
    const closing = reader.close();
    expect(reader.close()).toBe(closing);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(await reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'closed' });
  });

  it('closes a descriptor whose initial file identity is refused', async () => {
    const file = fixture();
    expect(await openIndexedRecordFile(file.dir, { allowedScopes: [indexedAddress()] })).toEqual({
      status: 'unknown',
      reason: 'unavailable',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a timed-out preparation retains its descriptor until the pending read settles', async () => {
    const file = fixture();
    vi.useFakeTimers();
    const held = holdNextRead();
    const opening = openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()], timeoutMs: 100 });
    await held.ready;
    await vi.advanceTimersByTimeAsync(100);
    expect(await opening).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(close).not.toHaveBeenCalled();
    held.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('timed-out reads retain their single slot; close waits for actual filesystem settlement', async () => {
    const file = fixture();
    const opened = await openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()], timeoutMs: 100 });
    if (opened.status !== 'ready') throw Error('fixture');
    vi.useFakeTimers();
    const held = holdNextRead();
    const pending = opened.reader.readScope(indexedAddress());
    await held.ready;
    const pendingStats = opened.reader.stats;
    expect(await opened.reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'busy' });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(await opened.reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'busy' });
    const closing = opened.reader.close();
    expect(close).not.toHaveBeenCalled();
    held.release();
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(pendingStats.readCalls).toBe(1);
    expect(pendingStats.scopeBytes).toBe(0);
  });

  it('cancellation during a held read never returns late evidence', async () => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    const held = holdNextRead();
    const controller = new AbortController();
    const pending = reader.readScope(indexedAddress(), { signal: controller.signal });
    await held.ready;
    controller.abort('PRIVATE');
    expect(await pending).toEqual({ status: 'unknown', reason: 'cancelled' });
    const closing = reader.close();
    held.release();
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
