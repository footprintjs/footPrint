import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readStoredRecord } from 'foottrace';
import { type RecordEntry, EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { fileIdentity } from '../../../src/lib/sinks/indexedIO.js';
import { decodePublishedRecordIndex } from '../../../src/lib/sinks/publishedRecordIndex.js';
import { indexedFileSink, readRecordFile } from '../../../src/sinks.js';

const audience = 'local';
const root = { logRunId: 'root', drillPath: [] };
const child = { logRunId: 'root', drillPath: ['mount#1'] };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fp-published-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function observedIdentity(path: string) {
  const fd = openSync(path, 'r');
  try {
    return fileIdentity(fd);
  } finally {
    closeSync(fd);
  }
}

async function publish(
  write: (sink: ReturnType<typeof indexedFileSink>) => void | Promise<void>,
  options: { maxEntryBytes?: number } = {},
) {
  const payload = join(directory, 'record.jsonl');
  const sidecar = join(directory, 'index.json');
  const sink = indexedFileSink(payload, { audience, ...options });
  try {
    await write(sink);
    const publication = await sink.seal(sidecar);
    const bytes = readFileSync(sidecar);
    const identity = observedIdentity(payload);
    return { payload, bytes, publication, identity, index: decodePublishedRecordIndex(bytes, publication, identity) };
  } finally {
    await sink.close();
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function rangeRows(payload: Buffer, offset: number, bytes: number): readonly RecordEntry[] {
  return payload
    .subarray(offset, offset + bytes)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('published recording writer and index validation', () => {
  it('indexes exact UTF-8 ranges, producer rows and native evidence through interleaved scopes', async () => {
    const record = await publish((sink) => {
      const memory = new SharedMemory(undefined, { input: '合計🧭' });
      const main = new EventLog({ input: '合計🧭' }, { sink, address: root, collects: { reads: 'keys' } });
      const mount = new EventLog({}, { sink, address: child });
      main.noteRun('run.stage', { id: 'use#0' });
      mount.note('work', { marker: '子' });
      new RecordFrame(memory, main).commit(() => ({
        stage: 'Use',
        stageId: 'use',
        runtimeStageId: 'use#0',
        about: { reads: ['input'] },
      }));
      mount.close('ok');
      main.close('ok');
    });
    const bytes = readFileSync(record.payload);
    expect(record.publication).toEqual({
      audience,
      payload: record.identity,
      indexBytes: record.bytes.length,
      indexDigest: sha256(record.bytes),
    });
    let offset = 0;
    let firstRow = 0;
    const decodedRows: RecordEntry[] = [];
    for (const range of record.index.ranges) {
      if (range.status !== 'written') throw new Error('Fixture should have no omitted ranges');
      const rows = rangeRows(bytes, range.offset, range.bytes);
      expect(range.offset).toBe(offset);
      expect(range.firstRow).toBe(firstRow);
      expect(range.rowCount).toBe(rows.length);
      expect(range.digest).toBe(sha256(bytes.subarray(offset, offset + range.bytes)));
      expect(range.maxLineBytes).toBe(Math.max(...rows.map((row) => Buffer.byteLength(`${JSON.stringify(row)}\n`))));
      for (const row of rows) expect(row.address).toEqual(range.address);
      decodedRows.push(...rows);
      offset += range.bytes;
      firstRow += range.rowCount;
    }
    expect(offset).toBe(bytes.length);
    expect(decodedRows).toEqual(readRecordFile(record.payload).entries);
    const noteOnly = record.index.ranges.find((range) => range.firstRow === 2);
    expect(noteOnly).toMatchObject({ address: root, rowCount: 1 });
    expect(noteOnly).not.toHaveProperty('firstCommit');
    expect(noteOnly).not.toHaveProperty('closedThrough');
    expect(decodedRows.filter((row) => row.address.drillPath.length === 0)).toMatchObject([
      { kind: 'opened', collects: { reads: 'keys' } },
      { kind: 'note', note: 'run.stage' },
      { kind: 'commit', about: { reads: ['input'] } },
      { kind: 'closed', outcome: 'ok', runNotes: 1 },
    ]);
  });

  it.each(['full', 'delta'] as const)(
    'keeps the genuine pause close and continuation in separate %s ranges',
    async (commitValues) => {
      const chart = flowChart<{ items: string[] }>(
        'Receive',
        (scope) => {
          scope.items = ['received'];
        },
        'receive',
      )
        .addPausableFunction(
          'Approve',
          { execute: () => ({ question: 'Approve?' }), resume: () => undefined },
          'approve',
        )
        .addFunction(
          'Finish',
          (scope) => {
            scope.items = [...scope.items, 'completed'];
          },
          'finish',
        )
        .build();
      const record = await publish(async (sink) => {
        const executor = new FlowChartExecutor(chart, { sink, commitValues });
        await executor.run();
        const checkpoint = executor.getCheckpoint();
        if (!checkpoint) throw new Error('Native pause did not yield a checkpoint');
        await executor.resume(checkpoint, {});
      });
      const [before, after, ...remaining] = record.index.ranges;
      if (before?.status !== 'written' || after?.status !== 'written') throw new Error('Expected two native ranges');
      expect(remaining).toHaveLength(0);
      expect(after.address).toEqual(before.address);
      expect(after.firstRow).toBe(before.rowCount);
      expect(after.firstCommit).toBe((before.lastCommit ?? -1) + 1);
      const bytes = readFileSync(record.payload);
      const paused = rangeRows(bytes, before.offset, before.bytes);
      const continued = rangeRows(bytes, after.offset, after.bytes);
      expect(paused.at(-1)).toMatchObject({
        kind: 'closed',
        outcome: 'paused',
        commits: (before.closedThrough ?? -1) + 1,
      });
      expect(continued[0]).toMatchObject({ kind: 'note', note: 'resume' });
      expect(continued.at(-1)).toMatchObject({
        kind: 'closed',
        outcome: 'ok',
        commits: (after.closedThrough ?? -1) + 1,
      });
      expect(readStoredRecord([...paused, ...continued]).log(before.address)).toMatchObject({
        complete: true,
        outcome: 'ok',
      });
    },
  );

  it('keeps a writer refusal as a positioned omission without writing its payload', async () => {
    const record = await publish(
      (sink) => {
        const log = new EventLog({}, { sink, address: root });
        log.note('wide', { value: 'sentinel'.repeat(512) });
        log.close('ok');
      },
      { maxEntryBytes: 1024 },
    );
    expect(record.index.ranges.map((range) => range.status)).toEqual(['written', 'omitted', 'written']);
    expect(record.index.ranges[1]).toEqual({
      id: 1,
      address: root,
      firstRow: 1,
      rowCount: 1,
      status: 'omitted',
      reason: 'too-large',
    });
    expect(readFileSync(record.payload, 'utf8')).not.toContain('sentinel');
    expect(readRecordFile(record.payload).entries).toMatchObject([{ kind: 'opened' }, { kind: 'closed' }]);
  });

  it('refuses the same payload with an independently unbound index or identity', async () => {
    const record = await publish((sink) => new EventLog({}, { sink, address: root }).close('ok'));
    expect(record.index.ranges).toHaveLength(1);
    const wrongDirectory = JSON.stringify({ version: 1, ranges: [] }).padEnd(record.bytes.length, ' ');
    expect(() =>
      decodePublishedRecordIndex(Buffer.from(wrongDirectory), record.publication, record.identity),
    ).toThrow();
    expect(() =>
      decodePublishedRecordIndex(record.bytes, record.publication, { ...record.identity, key: 'other' }),
    ).toThrow();
    expect(() => decodePublishedRecordIndex(record.bytes.subarray(1), record.publication, record.identity)).toThrow();
  });

  it('rejects bad row and byte geometry even when the host binding matches the index bytes', async () => {
    const record = await publish((sink) => {
      new EventLog({}, { sink, address: root }).close('ok');
      new EventLog({}, { sink, address: child }).close('ok');
    });
    const [first, second] = record.index.ranges;
    if (first?.status !== 'written' || second?.status !== 'written') throw new Error('Expected two native scopes');
    for (const invalid of [
      { firstRow: first.firstRow },
      { offset: first.offset },
      { maxLineBytes: second.bytes + 1 },
    ]) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, ranges: [first, { ...second, ...invalid }] }));
      const claimed = { ...record.publication, indexBytes: bytes.length, indexDigest: sha256(bytes) };
      expect(() => decodePublishedRecordIndex(bytes, claimed, record.identity)).toThrow();
    }
  });

  it('does not replace an existing sidecar or use the payload as its sidecar', async () => {
    const payload = join(directory, 'record.jsonl');
    const sidecar = join(directory, 'index.json');
    writeFileSync(sidecar, 'trusted original', { mode: 0o600 });
    const sink = indexedFileSink(payload, { audience });
    try {
      new EventLog({}, { sink, address: root }).close('ok');
      await expect(sink.seal(payload)).rejects.toThrow();
      await expect(sink.seal(sidecar)).rejects.toThrow();
      expect(readFileSync(sidecar, 'utf8')).toBe('trusted original');
      expect(readRecordFile(payload).entries).toMatchObject([{ kind: 'opened' }, { kind: 'closed' }]);
    } finally {
      await sink.close();
    }
  });
});
