/**
 * readRecordFile reads the file as its one `fstat` saw it. A file that grows between that `fstat` and the read (a
 * live sink still appending) is read up to the size seen, never refused as "past the limit" while far below
 * `maxBytes`. The growth is made deterministic by stubbing the size `fstat` reports.
 */
import { fstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRecordFile } from '../../../../src/sinks.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});
const actualFstat = vi.mocked(fstatSync).getMockImplementation()!;

/** The next `fstat` reports `bytes` fewer than the file holds: the file grew by that much after it. */
function fileGrowsAfterStat(bytes: number): void {
  vi.mocked(fstatSync).mockImplementationOnce(((fd: number) => {
    const stat = actualFstat(fd);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: stat.size - bytes });
  }) as typeof fstatSync);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-read-growth-'));
});
afterEach(() => {
  vi.mocked(fstatSync).mockImplementation(actualFstat).mockClear();
  rmSync(dir, { recursive: true, force: true });
});

describe('readRecordFile — a file that grows while it is read', () => {
  it('one byte of growth far below maxBytes is not refused; the bytes fstat saw are read', () => {
    const path = join(dir, 'live.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    fileGrowsAfterStat(1);
    const read = readRecordFile(path, { maxBytes: 1_000_000 });
    expect(read.entries).toEqual([{ a: 1 }, { b: 2 }]);
    expect(read.unreadable).toEqual([]);
  });

  it('an entry appended after fstat is not read; one cut by the size seen is reported as unreadable', () => {
    const path = join(dir, 'live.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    fileGrowsAfterStat(4);
    const read = readRecordFile(path);
    expect(read.entries).toEqual([{ a: 1 }]);
    expect(read.unreadable).toEqual([{ line: 2, reason: expect.stringContaining('not JSON') }]);
  });

  it('maxBytes stays exact: a file of maxBytes reads, one byte more is refused', () => {
    const path = join(dir, 'edge.jsonl');
    writeFileSync(path, '{"a":1}\n');
    expect(readRecordFile(path, { maxBytes: 8 }).entries).toEqual([{ a: 1 }]);
    expect(() => readRecordFile(path, { maxBytes: 7 })).toThrow(RangeError);
  });
});
