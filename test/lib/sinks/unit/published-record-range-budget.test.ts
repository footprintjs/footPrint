import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { indexedAddress } from '../../../../src/lib/sinks/indexedAdmission.js';
import { digest, openIndexedDescriptor } from '../../../../src/lib/sinks/indexedIO.js';
import { readPublishedRows } from '../../../../src/lib/sinks/publishedRecordRows.js';
import type { PublishedRecordRange } from '../../../../src/lib/sinks/publishedRecordWriter.js';

type WrittenRange = Extract<PublishedRecordRange, { readonly status: 'written' }>;

const address = { logRunId: 'run-1', drillPath: ['child#0'] };
const scope = indexedAddress(address);
const maxEntryBytes = 8 * 1024 * 1024;
const encoder = new TextEncoder();

function opened(value: unknown) {
  return { kind: 'opened', address, at: 0, initialState: { value } };
}

function note(value: unknown) {
  return { kind: 'note', address, at: 1, note: 'probe', data: { value } };
}

function nestedArray(layers: number, inner: unknown): unknown {
  return Array.from({ length: layers }).reduce<unknown>((value) => [value], inner);
}

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fp-published-range-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeRanges(lines: readonly string[]): readonly WrittenRange[] {
  const parts = lines.map((line) => encoder.encode(line));
  const payload = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  const ranges = parts.map((part, id): WrittenRange => {
    payload.set(part, offset);
    const range: WrittenRange = {
      status: 'written',
      address,
      id,
      firstRow: id,
      rowCount: 1,
      offset,
      bytes: part.byteLength,
      maxLineBytes: part.byteLength,
      digest: digest(part),
    };
    offset += part.byteLength;
    return range;
  });
  writeFileSync(join(directory, 'rows.jsonl'), payload);
  return ranges;
}

async function read(ranges: readonly WrittenRange[], maxLineBytes = maxEntryBytes) {
  const fd = openIndexedDescriptor(join(directory, 'rows.jsonl'));
  const count = vi.fn<(bytes: number) => void>();
  const submitted = vi.fn<() => void>();
  try {
    const result = await readPublishedRows(
      fd,
      scope,
      ranges,
      maxLineBytes,
      new AbortController().signal,
      count,
      submitted,
    );
    return { result, count, submitted };
  } finally {
    closeSync(fd);
  }
}

function line(row: unknown): string {
  return JSON.stringify(row) + '\n';
}

describe('published range read limits and admission', () => {
  it('counts array and object values without treating escaped text as structure', async () => {
    const value = ['[{"'.repeat(120), { '}":[': '\\"[],' }, true, null, -1.25e19, [], {}];
    const rows = [opened(value), note('after')];
    const ranges = writeRanges(rows.map(line));
    await expect(read(ranges)).resolves.toMatchObject({ result: { status: 'loaded', rows } });
  });

  it('admits an empty array at the depth limit, then refuses a leaf one level deeper', async () => {
    const safe = opened(nestedArray(98, []));
    const tooDeep = note(nestedArray(99, 0));
    const ranges = writeRanges([line(safe), line(tooDeep)]);
    await expect(read(ranges.slice(0, 1))).resolves.toMatchObject({ result: { status: 'loaded', rows: [safe] } });
    await expect(read(ranges)).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 1, reason: 'too-large' } },
    });
  });

  it('shares the value-work budget across ranges with broad nested arrays', async () => {
    const value = [Array.from({ length: 100000 }, () => 0)];
    const ranges = writeRanges([line(opened(value)), line(note(value))]);
    const { result } = await read(ranges.slice(0, 1));
    expect(result.status).toBe('loaded');
    await expect(read(ranges)).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 1, reason: 'too-large' } },
    });
  });

  it('refuses an advertised oversized row before submitting payload I/O', async () => {
    const ranges = writeRanges([line(opened('limitable payload'))]);
    const { result, submitted } = await read(ranges, ranges[0].maxLineBytes - 1);
    expect(result).toEqual({ status: 'omitted', omitted: { id: 0, reason: 'too-large' } });
    expect(submitted).not.toHaveBeenCalled();
  });

  it.each([
    { detail: 'another native address', input: line({ ...opened(1), address: { ...address, drillPath: [] } }) },
    { detail: 'a line without its terminator', input: JSON.stringify(opened(1)) },
  ])('refuses a whole range containing $detail', async ({ input }) => {
    const ranges = writeRanges([input]);
    await expect(read(ranges)).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 0, reason: 'invalid-data' } },
    });
  });

  it('distinguishes bad payload integrity from wrong advertised row and commit bounds', async () => {
    const [range] = writeRanges([line({ kind: 'commit', address, at: 1, bundle: { idx: 4 } })]);
    const bounds = { ...range, firstCommit: 4, lastCommit: 4 };
    await expect(read([bounds])).resolves.toMatchObject({ result: { status: 'loaded' } });
    await expect(read([{ ...bounds, digest: '0'.repeat(64) }])).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 0, reason: 'stale' } },
    });
    await expect(read([{ ...bounds, rowCount: 2 }])).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 0, reason: 'invalid-data' } },
    });
    await expect(read([{ ...bounds, lastCommit: 5 }])).resolves.toMatchObject({
      result: { status: 'omitted', omitted: { id: 0, reason: 'invalid-data' } },
    });
  });
});
