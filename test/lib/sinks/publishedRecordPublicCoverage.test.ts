import { closeSync, mkdtempSync, openSync, read, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogAddress } from 'foottrace';
import { type RecordEntry, EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { afterEach, expect, it, vi } from 'vitest';

import { digest, fileIdentity } from '../../../src/lib/sinks/indexedIO.js';
import type { PublishedRecordIndex } from '../../../src/lib/sinks/publishedRecordWriter.js';
import { indexedFileSink, openIndexedRecordFile, openPublishedRecordFile, readRecordFile } from '../../../src/sinks.js';

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
const privateReadDetail = 'private transport detail';

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

function failNextRead() {
  observedRead.mockImplementationOnce(((
    _fd: number,
    _buffer: Uint8Array,
    _offset: number,
    _length: number,
    _position: number,
    callback: (error: NodeJS.ErrnoException, bytesRead: number) => void,
  ) => callback(Object.assign(new Error(privateReadDetail), { code: 'EIO' }), 0)) as typeof read);
}

function recordingPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'fp-published-public-'));
  directories.push(directory);
  return { payload: join(directory, 'record.jsonl'), sidecar: join(directory, 'index.json') };
}

async function publishedView(
  layout: 'compact' | 'interleaved',
  { laterNote = '', omitLaterRange = false }: { laterNote?: string; omitLaterRange?: boolean } = {},
) {
  const { payload, sidecar } = recordingPaths();
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

it('loads a healthy publication through both public methods', async () => {
  const opened = await openView(await publishedView('compact'));
  try {
    await expect(opened.reader.readScope(root)).resolves.toMatchObject({ status: 'loaded', coverage: 'whole' });
    await expect(opened.reader.readState(root, -1)).resolves.toMatchObject({
      status: 'loaded',
      coverage: 'prefix',
      state: { throughCommitIdx: -1, state: { step: 0 } },
    });
  } finally {
    await opened.reader.close();
  }
});

it.each(['scope', 'state'] as const)('reports a failed published %s payload read as unavailable', async (kind) => {
  const opened = await openView(await publishedView('compact'));
  try {
    const callsBefore = observedRead.mock.calls.length;
    failNextRead();
    const result = kind === 'scope' ? await opened.reader.readScope(root) : await opened.reader.readState(root, -1);
    expect(observedRead).toHaveBeenCalledTimes(callsBefore + 1);
    expect(JSON.stringify(result)).not.toContain(privateReadDetail);
    expect(result).toEqual({ status: 'unknown', reason: 'unavailable', omissions: [{ reason: 'unavailable' }] });
  } finally {
    await opened.reader.close();
  }
});

it('reports the same payload read failure as unavailable after scanning', async () => {
  const recording = await publishedView('compact');
  const opened = await openIndexedRecordFile(recording.payload, { allowedScopes: [root] });
  if (opened.status !== 'ready') throw new Error(`Scanning recording refused: ${opened.reason}`);
  try {
    const callsBefore = observedRead.mock.calls.length;
    failNextRead();
    const result = await opened.reader.readScope(root);
    expect(observedRead).toHaveBeenCalledTimes(callsBefore + 1);
    expect(JSON.stringify(result)).not.toContain(privateReadDetail);
    expect(result).toEqual({ status: 'unknown', reason: 'unavailable' });
  } finally {
    await opened.reader.close();
  }
});

it('reports malformed JSON as invalid data when the publication matches its bytes', async () => {
  const { payload, sidecar } = recordingPaths();
  const row = Buffer.from('{"value":tru}\n');
  const index: PublishedRecordIndex = {
    version: 1,
    ranges: [
      {
        address: root,
        id: 0,
        firstRow: 0,
        rowCount: 1,
        status: 'written',
        offset: 0,
        bytes: row.length,
        maxLineBytes: row.length,
        digest: digest(row),
      },
    ],
  };
  const directory = Buffer.from(JSON.stringify(index));
  writeFileSync(payload, row, { mode: 0o600 });
  writeFileSync(sidecar, directory, { mode: 0o600 });
  const fd = openSync(payload, 'r');
  let payloadIdentity: ReturnType<typeof fileIdentity>;
  try {
    payloadIdentity = fileIdentity(fd);
  } finally {
    closeSync(fd);
  }
  const publication = {
    audience,
    payload: payloadIdentity,
    indexBytes: directory.length,
    indexDigest: digest(directory),
  };
  const opened = await openView({ payload, sidecar, publication });
  try {
    const invalid = { status: 'unknown', reason: 'invalid-data', omissions: [{ reason: 'invalid-data' }] };
    await expect(opened.reader.readScope(root)).resolves.toEqual(invalid);
    await expect(opened.reader.readState(root, -1)).resolves.toEqual(invalid);
  } finally {
    await opened.reader.close();
  }
});

it('retains the published reader slot and delays close until its pending read callback settles', async () => {
  if (!actualRead) throw new Error('Missing native read instrumentation');
  const opened = await openView(await publishedView('compact'));
  let releaseRead: () => void = () => undefined;
  let markReadStarted: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
  observedRead.mockImplementationOnce(((...args: Parameters<typeof read>) => {
    releaseRead = () => actualRead(...args);
    markReadStarted();
  }) as typeof read);

  let closing: Promise<void> | undefined;
  try {
    const controller = new AbortController();
    const pending = opened.reader.readScope(root, { signal: controller.signal });
    await readStarted;
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'unknown', reason: 'cancelled' });
    await expect(opened.reader.readScope(root)).resolves.toEqual({ status: 'unknown', reason: 'busy' });

    let closed = false;
    closing = opened.reader.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
  } finally {
    releaseRead();
    await (closing ?? opened.reader.close());
  }
  await expect(opened.reader.readScope(root)).resolves.toEqual({ status: 'unknown', reason: 'closed' });
});
