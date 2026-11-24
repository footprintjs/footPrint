import { mkdtempSync, read, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogAddress } from 'foottrace';
import { type RecordEntry, EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { afterEach, expect, it, vi } from 'vitest';

import { indexedFileSink, openPublishedRecordFile, readRecordFile } from '../../../src/sinks.js';

const audience = 'local';
const root: LogAddress = { logRunId: 'root', drillPath: [] };
const child: LogAddress = { logRunId: 'root', drillPath: ['mount#0'] };
const directories: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, read: vi.fn(actual.read) };
});

const observedRead = vi.mocked(read);
const actualRead = observedRead.getMockImplementation();

afterEach(() => {
  observedRead.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function shortReadAfter(successfulReads: number) {
  if (!actualRead) throw new Error('Missing native read instrumentation');
  for (let i = 0; i < successfulReads; i++) observedRead.mockImplementationOnce(actualRead);
  observedRead.mockImplementationOnce(((
    _fd: number,
    _buffer: Uint8Array,
    _offset: number,
    _length: number,
    _position: number,
    callback: (error: null, bytesRead: number) => void,
  ) => callback(null, 0)) as typeof read);
}

async function publishedView(
  layout: 'compact' | 'interleaved',
  { laterNote = '', omitLaterRange = false }: { laterNote?: string; omitLaterRange?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'fp-published-public-'));
  directories.push(directory);
  const payload = join(directory, 'record.jsonl');
  const sidecar = join(directory, 'index.json');
  const sink = indexedFileSink(payload, { audience });
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const memory = new SharedMemory(undefined, { step: 0 });
      const log = new EventLog({ step: 0 }, { sink, address: root });
      const commit = (step: number) => {
        const frame = new RecordFrame(memory, log);
        frame.write(['step'], step, 'set');
        frame.commit(() => ({ stage: 'Step', stageId: 'step', runtimeStageId: `step#${step - 1}` }));
      };
      commit(1);
      if (layout === 'interleaved') {
        new EventLog({ child: 'denied' }, { sink, address: child }).close('ok');
      }
      if (laterNote) log.note('later-note', { value: laterNote });
      commit(2);
      log.close('ok');
    } finally {
      clock.mockRestore();
    }
    if (omitLaterRange) shortReadAfter(2);
    return { payload, sidecar, publication: await sink.seal(sidecar) };
  } finally {
    await sink.close();
  }
}

async function openView(
  recording: Awaited<ReturnType<typeof publishedView>>,
  limits: Partial<
    Pick<Parameters<typeof openPublishedRecordFile>[3], 'maxEntryBytes' | 'maxScopeBytes' | 'maxEntries'>
  > = {},
) {
  const opened = await openPublishedRecordFile(recording.payload, recording.sidecar, recording.publication, {
    audience,
    allowedScopes: [root],
    ...limits,
  });
  if (opened.status !== 'ready') throw new Error(`Published recording refused: ${opened.reason}`);
  return opened;
}

it('serves identical logical coverage when a denied child changes physical packing', async () => {
  const compactRecording = await publishedView('compact');
  const splitRecording = await publishedView('interleaved');
  const compact = await openView(compactRecording);
  const split = await openView(splitRecording);
  try {
    const compactBase = await compact.reader.readState(root, -1);
    const splitBase = await split.reader.readState(root, -1);
    expect(compactBase).toMatchObject({
      status: 'loaded',
      coverage: 'prefix',
      state: { throughCommitIdx: -1, state: { step: 0 } },
    });
    expect(JSON.stringify(splitBase)).toBe(JSON.stringify(compactBase));

    const compactPrefix = await compact.reader.readState(root, 0);
    const splitPrefix = await split.reader.readState(root, 0);
    expect(compactPrefix).toMatchObject({
      status: 'loaded',
      coverage: 'prefix',
      state: { throughCommitIdx: 0, state: { step: 1 } },
    });
    expect(JSON.stringify(splitPrefix)).toBe(JSON.stringify(compactPrefix));
    expect(compactPrefix).not.toHaveProperty('bytesRead');
    expect(compact.reader).not.toHaveProperty('stats');
    expect(compact.diagnostics.stats.preparationBytes).not.toBe(split.diagnostics.stats.preparationBytes);

    const compactComplete = await compact.reader.readState(root, 1);
    const splitComplete = await split.reader.readState(root, 1);
    expect(compactComplete).toMatchObject({
      status: 'loaded',
      coverage: 'whole',
      state: { throughCommitIdx: 1, state: { step: 2 } },
    });
    expect(JSON.stringify(splitComplete)).toBe(JSON.stringify(compactComplete));

    const beforeWhole = split.diagnostics.stats;
    const compactWhole = await compact.reader.readScope(root);
    const splitWhole = await split.reader.readScope(root);
    const afterWhole = split.diagnostics.stats;
    expect(splitWhole).toMatchObject({ status: 'loaded', coverage: 'whole' });
    expect(JSON.stringify(splitWhole)).toBe(JSON.stringify(compactWhole));
    expect(splitWhole).not.toHaveProperty('bytesRead');
    const rootBytes = (readRecordFile(splitRecording.payload).entries as readonly RecordEntry[])
      .filter((row) => row.address.drillPath.length === 0)
      .reduce((bytes, row) => bytes + Buffer.byteLength(`${JSON.stringify(row)}\n`), 0);
    expect(afterWhole.scopeBytes - beforeWhole.scopeBytes).toBe(rootBytes);
    expect(afterWhole.readCalls).toBeGreaterThan(compact.diagnostics.stats.readCalls);

    expect(await split.reader.readScope(child)).toEqual({ status: 'unknown', reason: 'not-permitted' });
    expect(split.diagnostics.stats).toEqual(afterWhole);
  } finally {
    await Promise.all([compact.reader.close(), split.reader.close()]);
  }
});

it.each([
  { dimension: 'line', limits: { maxEntryBytes: 1024 } },
  { dimension: 'bytes', limits: { maxScopeBytes: 1024 } },
  { dimension: 'rows', limits: { maxEntries: 2 } },
])('enforces the $dimension bound on the logical prefix across layouts', async ({ limits }) => {
  const wideNote = 'x'.repeat(4096);
  const compact = await openView(await publishedView('compact', { laterNote: wideNote }), limits);
  const split = await openView(await publishedView('interleaved', { laterNote: wideNote }), limits);
  try {
    const compactPrefix = await compact.reader.readState(root, 0);
    const splitPrefix = await split.reader.readState(root, 0);
    expect(compactPrefix).toMatchObject({
      status: 'loaded',
      coverage: 'prefix',
      state: { throughCommitIdx: 0, state: { step: 1 } },
    });
    expect(JSON.stringify(splitPrefix)).toBe(JSON.stringify(compactPrefix));
    const tooLarge = {
      status: 'unknown',
      reason: 'too-large',
      omissions: [{ reason: 'too-large' }],
    };
    expect(await compact.reader.readState(root, 1)).toEqual(tooLarge);
    expect(await split.reader.readState(root, 1)).toEqual(tooLarge);
  } finally {
    await Promise.all([compact.reader.close(), split.reader.close()]);
  }
});

it('retains a verified prefix while naming a later authorized range the writer could not verify', async () => {
  // The writer admits the first root range and the child range before it reaches the second root range.
  const opened = await openView(await publishedView('interleaved', { omitLaterRange: true }));
  try {
    expect(await opened.reader.readState(root, 0)).toMatchObject({
      status: 'loaded',
      coverage: 'prefix',
      state: { throughCommitIdx: 0, state: { step: 1 } },
    });
    const unavailable = { status: 'unknown', reason: 'unavailable', omissions: [{ reason: 'unavailable' }] };
    expect(await opened.reader.readState(root, 1)).toEqual(unavailable);
    expect(await opened.reader.readScope(root)).toEqual(unavailable);
  } finally {
    await opened.reader.close();
  }
});

it('refuses the whole scope when a later authorized payload read is torn', async () => {
  const opened = await openView(await publishedView('interleaved'));
  try {
    shortReadAfter(1);
    expect(await opened.reader.readScope(root)).toEqual({
      status: 'unknown',
      reason: 'stale',
      omissions: [{ reason: 'stale' }],
    });
  } finally {
    await opened.reader.close();
  }
});
