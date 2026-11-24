import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type LogAddress, readStoredRecord } from 'foottrace';
import { type RecordEntry, EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { indexedFileSink, openIndexedRecordFile, openPublishedRecordFile, readRecordFile } from '../../../src/sinks.js';

const audience = 'local';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fp-published-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function publish(
  write: (sink: ReturnType<typeof indexedFileSink>) => void | Promise<void>,
  options: Partial<Pick<Parameters<typeof indexedFileSink>[1], 'maxEntryBytes'>> = {},
) {
  const payload = join(directory, 'record.jsonl');
  const sidecar = join(directory, 'index.json');
  const sink = indexedFileSink(payload, { audience, ...options });
  try {
    await write(sink);
    return { payload, sidecar, publication: await sink.seal(sidecar) };
  } finally {
    await sink.close();
  }
}

type Publication = Awaited<ReturnType<typeof publish>>;

async function open(
  { payload, sidecar, publication }: Publication,
  allowedScopes: readonly LogAddress[],
  options: Partial<Pick<Parameters<typeof openPublishedRecordFile>[3], 'maxScopeBytes' | 'maxEntryBytes'>> = {},
) {
  const result = await openPublishedRecordFile(payload, sidecar, publication, { audience, allowedScopes, ...options });
  if (result.status !== 'ready') throw new Error(`Published recording refused: ${result.reason}`);
  return result.reader;
}

const root: LogAddress = { logRunId: 'root', drillPath: [] };

describe('published recording file', () => {
  it('binds the directory to the trusted publication even when the payload is unchanged', async () => {
    const record = await publish((sink) => new EventLog({ count: 1 }, { sink, address: root }).close('ok'));
    const index = readFileSync(record.sidecar);
    const directory = JSON.parse(index.toString('utf8')) as { ranges: unknown[] };
    expect(directory.ranges.length).toBeGreaterThan(0);

    const reader = await open(record, [root]);
    try {
      expect(await reader.readScope(root)).toMatchObject({ status: 'loaded', coverage: 'whole' });
    } finally {
      await reader.close();
    }
    expect(
      await openPublishedRecordFile(record.payload, record.sidecar, record.publication, {
        audience: 'different',
        allowedScopes: [root],
      }),
    ).toEqual({ status: 'unknown', reason: 'not-permitted' });

    const replacement = JSON.stringify({ ...directory, ranges: [] });
    const changed = Buffer.concat([
      Buffer.from(replacement),
      Buffer.alloc(index.length - Buffer.byteLength(replacement), 32),
    ]);
    expect(changed).toHaveLength(index.length);
    writeFileSync(record.sidecar, changed);
    expect(
      await openPublishedRecordFile(record.payload, record.sidecar, record.publication, {
        audience,
        allowedScopes: [root],
      }),
    ).toEqual({ status: 'unknown', reason: 'stale' });

    unlinkSync(record.sidecar);
    expect(
      await openPublishedRecordFile(record.payload, record.sidecar, record.publication, {
        audience,
        allowedScopes: [root],
      }),
    ).toEqual({ status: 'unknown', reason: 'unavailable' });
  });

  it('opens by the index alone and reads only the authorized native scope', async () => {
    interface State {
      rootMark?: string;
      childMark?: string;
    }
    const child = flowChart<State>(
      'Child',
      (scope) => {
        scope.childMark = 'child only'.repeat(4096);
      },
      'child',
    ).build();
    const chart = flowChart<State>(
      'Root',
      (scope) => {
        scope.rootMark = 'root only';
      },
      'root',
    )
      .addSubFlowChartNext('mount', child, 'Child', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .build();
    const record = await publish(async (sink) => {
      await new FlowChartExecutor(chart, { sink }).run();
    });
    const rows = readRecordFile(record.payload).entries as readonly RecordEntry[];
    const rootRows = rows.filter((row) => row.address.drillPath.length === 0);
    const childRows = rows.filter((row) => row.address.drillPath.length === 1);
    const rootAddress = rootRows[0]?.address;
    const childAddress = childRows[0]?.address;
    if (!rootAddress || !childAddress) throw new Error('Native recording did not include root and child logs');
    const scopeSize = (entries: typeof rows) =>
      entries.reduce((sum, row) => sum + Buffer.byteLength(`${JSON.stringify(row)}\n`), 0);
    const expectedRootBytes = scopeSize(rootRows);
    const expectedChildBytes = scopeSize(childRows);

    const old = await openIndexedRecordFile(record.payload, { allowedScopes: [rootAddress] });
    if (old.status !== 'ready') throw new Error('Legacy indexed reader could not open native recording');
    try {
      expect(old.reader.stats.preparationBytes).toBe(statSync(record.payload).size);
      expect(await old.reader.readScope(rootAddress)).toMatchObject({
        status: 'loaded',
        entries: rootRows,
        bytesRead: expectedRootBytes,
      });
    } finally {
      await old.reader.close();
    }

    const rootReader = await open(record, [rootAddress]);
    try {
      expect(rootReader.stats).toMatchObject({
        preparationBytes: statSync(record.sidecar).size,
        scopeBytes: 0,
        readCalls: 0,
      });
      expect(await rootReader.readScope(childAddress)).toMatchObject({ status: 'unknown', reason: 'not-permitted' });
      expect(rootReader.stats).toMatchObject({ scopeBytes: 0, readCalls: 0 });
      expect(await rootReader.readScope(rootAddress)).toEqual({
        status: 'loaded',
        coverage: 'whole',
        entries: rootRows,
        bytesRead: expectedRootBytes,
      });
      expect(rootReader.stats.scopeBytes).toBe(expectedRootBytes);
      expect(expectedRootBytes).toBeLessThan(statSync(record.payload).size);
    } finally {
      await rootReader.close();
    }

    const childReader = await open(record, [childAddress]);
    try {
      expect(await childReader.readScope(childAddress)).toEqual({
        status: 'loaded',
        coverage: 'whole',
        entries: childRows,
        bytesRead: expectedChildBytes,
      });
      expect(childReader.stats.scopeBytes).toBe(expectedChildBytes);
    } finally {
      await childReader.close();
    }
  });

  it.each(['full', 'delta'] as const)('keeps the genuine pause close a prefix in %s encoding', async (commitValues) => {
    interface State {
      received?: boolean;
      approved?: boolean;
      completed?: boolean;
      items?: string[];
    }
    const chart = flowChart<State>(
      'Receive',
      (scope) => {
        scope.received = true;
        scope.items = ['received'];
      },
      'receive',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: () => ({ question: 'Approve?' }),
          resume: (scope) => {
            scope.approved = true;
          },
        },
        'approve',
      )
      .addFunction(
        'Finish',
        (scope) => {
          scope.completed = true;
          scope.items = [...(scope.items ?? []), 'completed'];
        },
        'finish',
      )
      .build();
    const snapshots: ReturnType<FlowChartExecutor['getSnapshot']>[] = [];
    const record = await publish(async (sink) => {
      const executor = new FlowChartExecutor(chart, { sink, commitValues });
      await executor.run();
      snapshots.push(executor.getSnapshot());
      const checkpoint = executor.getCheckpoint();
      if (!checkpoint) throw new Error('Native pause did not yield a checkpoint');
      await executor.resume(checkpoint, {});
      const resumed = executor.getSnapshot();
      snapshots.push(resumed);
      if (!resumed.logAddress) throw new Error('Resumed snapshot did not expose its native address');
      await sink.note({ address: resumed.logAddress, at: Date.now(), kind: 'review-note', data: {} });
    });
    const [paused, resumed] = snapshots;
    if (!paused?.logAddress || !resumed) throw new Error('Native recording did not include both execution legs');
    expect(resumed.runId).not.toBe(paused.runId);
    const address = paused.logAddress;
    expect(resumed.logAddress).toEqual(address);
    const pausedAt = paused.commitLog.length - 1;
    const reader = await open(record, [address]);
    try {
      const early = await reader.readState(address, pausedAt);
      expect(early).toMatchObject({
        status: 'loaded',
        coverage: 'prefix',
        pauses: [pausedAt],
        state: { throughCommitIdx: pausedAt, state: paused.sharedState },
      });
      expect(early).not.toHaveProperty('entries');
      if (early.status !== 'loaded') throw new Error(`Paused state refused: ${early.reason}`);

      const throughAllCommits = await reader.readState(address, resumed.commitLog.length - 1);
      expect(throughAllCommits).toMatchObject({
        status: 'loaded',
        coverage: 'prefix',
        state: { state: resumed.sharedState },
      });
      const whole = await reader.readScope(address);
      if (whole.status !== 'loaded') throw new Error(`Complete log refused: ${whole.reason}`);
      expect(whole.coverage).toBe('whole');
      expect(early.bytesRead).toBeLessThan(whole.bytesRead);
      expect(whole.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'closed', outcome: 'paused', commits: pausedAt + 1 }),
          expect.objectContaining({ kind: 'note', note: 'resume' }),
          expect.objectContaining({ kind: 'note', note: 'review-note' }),
        ]),
      );
      expect(readStoredRecord(whole.entries).log(address)).toMatchObject({ complete: true, outcome: 'ok' });
      expect(await reader.readState(address, resumed.commitLog.length)).toMatchObject({
        status: 'unknown',
        reason: 'unavailable',
      });
    } finally {
      await reader.close();
    }
  });

  it('round trips native collection, commit and close evidence', async () => {
    const record = await publish((sink) => {
      const memory = new SharedMemory(undefined, { input: 7 });
      const log = new EventLog({ input: 7 }, { sink, address: root, collects: { reads: 'keys' } });
      log.noteRun('run.stage', { id: 'use#0' });
      new RecordFrame(memory, log).commit(() => ({
        stage: 'Use',
        stageId: 'use',
        runtimeStageId: 'use#0',
        about: { reads: ['input'] },
      }));
      log.close('ok');
    });
    const reader = await open(record, [root]);
    try {
      const loaded = await reader.readScope(root);
      if (loaded.status !== 'loaded') throw new Error(`Evidence refused: ${loaded.reason}`);
      expect(loaded.entries).toMatchObject([
        { kind: 'opened', collects: { reads: 'keys' } },
        { kind: 'note', note: 'run.stage' },
        { kind: 'commit', about: { reads: ['input'] } },
        { kind: 'closed', outcome: 'ok', runNotes: 1 },
      ]);
    } finally {
      await reader.close();
    }
  });

  it.each([
    { layout: 'root only', limit: 'line' },
    { layout: 'child before root', limit: 'line' },
    { layout: 'child between root notes', limit: 'line' },
    { layout: 'root only', limit: 'depth' },
    { layout: 'child before root', limit: 'depth' },
    { layout: 'child between root notes', limit: 'depth' },
  ])('reports the same $limit omission for $layout', async ({ layout, limit }) => {
    const child: LogAddress = { logRunId: root.logRunId, drillPath: ['mount#0'] };
    const record = await publish((sink) => {
      const writeChild = () => new EventLog({}, { sink, address: child }).close('ok');
      if (layout === 'child before root') writeChild();
      const log = new EventLog({}, { sink, address: root });
      log.note('first', { value: limit === 'line' ? 'x'.repeat(1024) : 'small' });
      if (layout === 'child between root notes') writeChild();
      const value =
        limit === 'line' ? 'y'.repeat(1024) : Array.from({ length: 102 }).reduce<unknown>((inner) => [inner], 0);
      log.note('second', { value });
      log.close('ok');
    });
    const reader = await open(record, [root], limit === 'line' ? { maxEntryBytes: 512 } : {});
    try {
      expect(await reader.readScope(child)).toEqual({ status: 'unknown', reason: 'not-permitted' });
      expect(reader.stats.scopeBytes).toBe(0);
      const result = await reader.readScope(root);
      const rootBytesRead = reader.stats.scopeBytes;
      if (limit === 'line') {
        expect(rootBytesRead).toBe(0);
      } else {
        expect(rootBytesRead).toBeGreaterThan(0);
        const expectedRootBytes = (readRecordFile(record.payload).entries as readonly RecordEntry[])
          .filter((row) => row.address.drillPath.length === 0)
          .reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
        expect(rootBytesRead).toBe(expectedRootBytes);
      }
      expect(result).toEqual({
        status: 'unknown',
        reason: 'too-large',
        omissions: [{ reason: 'too-large' }],
      });
    } finally {
      await reader.close();
    }
  });

  it.each(['writer', 'reader total', 'reader line'] as const)(
    'names an oversized entry at the %s limit without reading it',
    async (limit) => {
      const other: LogAddress = { logRunId: 'other', drillPath: [] };
      const record = await publish(
        (sink) => {
          const log = new EventLog({}, { sink, address: root });
          log.note('wide', { value: 'x'.repeat(4096) });
          log.close('ok');
          new EventLog({}, { sink, address: other }).close('ok');
        },
        limit === 'writer' ? { maxEntryBytes: 1024 } : {},
      );
      const reader = await open(record, [root, other], {
        ...(limit === 'reader total' && { maxScopeBytes: 1024 }),
        ...(limit === 'reader line' && { maxEntryBytes: 1024 }),
      });
      try {
        expect(await reader.readScope(root)).toMatchObject({
          status: 'unknown',
          reason: 'too-large',
          omissions: [{ reason: 'too-large' }],
        });
        expect(reader.stats).toMatchObject({ scopeBytes: 0, readCalls: 0 });
        expect(await reader.readScope(other)).toMatchObject({ status: 'loaded', coverage: 'whole' });
      } finally {
        await reader.close();
      }
    },
  );
});
