import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogAddress, StoredLog } from 'foottrace';
import { buildAttemptId, parseAttemptId, readStoredRecord } from 'foottrace';
import type { RecordEntry } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import type { AttemptRecord, FlowAttemptEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { openIndexedRecordFile } from '../../../../src/sinks.js';

const target = 'fixture.complete';
const unavailable = { status: 'unavailable' };
const categories = new Set(['timeout', 'network', 'rate-limited', 'server', 'auth', 'permanent', 'unknown']);

const idOf = (record: AttemptRecord) => record.series + '@' + record.attempt;
const attemptRows = (log: StoredLog) =>
  log.notes.filter((note) => note.kind === 'attempt').map((note) => note.data.record as AttemptRecord);

// Compose the real saved-scope reader and Foottrace reader as a host would. The evidence result is local to the test.
async function readScope(path: string, allowedScopes: LogAddress[], address: LogAddress) {
  const opened = await openIndexedRecordFile(path, { allowedScopes });
  if (opened.status !== 'ready') throw new Error(opened.reason);
  try {
    const loaded = await opened.reader.readScope(address);
    return loaded.status === 'loaded' ? readStoredRecord(loaded.entries).log(address) : undefined;
  } finally {
    await opened.reader.close();
  }
}

function callOutcome(log: StoredLog | undefined, attemptId: string) {
  const parts = parseAttemptId(attemptId);
  if (!log || !parts?.call || buildAttemptId(parts.runtimeStageId, parts.attempt, parts.call) !== attemptId)
    return unavailable;
  const selected = attemptRows(log).filter((record) => record.kind === 'call' && idOf(record) === attemptId);
  if (selected.length !== 1) return unavailable;
  const [record] = selected;
  const failed = record.outcome === 'failed' || record.outcome === 'aborted' || record.outcome === 'timeout';
  if (failed && !categories.has(record.category ?? '')) return unavailable;
  return { status: 'available', attemptId, outcome: record.outcome, category: record.category };
}

async function recoveredRecording(stageId: string) {
  let entered = 0;
  const sink = memorySink();
  const events: FlowAttemptEvent[] = [];
  const chart = flowChart(
    'Retrying stage',
    async (scope) => {
      const stageAttempt = scope.$attempt();
      if (stageAttempt.attempt === 1) {
        stageAttempt.observed({
          target,
          attempt: 1,
          of: 1,
          outcome: 'failed',
          durationMs: 0,
          error: Object.assign(new Error('SYNTHETIC-sibling'), { status: 401 }),
        });
      }
      const providerError = Object.assign(new Error('SYNTHETIC-call'), { status: 503 });
      try {
        await scope.$call(
          target,
          () => {
            entered++;
            if (stageAttempt.attempt === 1) throw providerError;
            return 'recovered';
          },
          undefined,
          { errorDetails: 'classification-only' },
        );
      } catch (error) {
        expect(error).toBe(providerError);
        throw new Error('SYNTHETIC-stage');
      }
    },
    stageId,
  )
    .retry({ attempts: 2 })
    .build();

  const executor = new FlowChartExecutor(chart, { sink });
  const retries: string[] = [];
  executor.attachFlowRecorder({
    id: 'recorded-tries',
    onAttempt: (event) => events.push(event),
    onStageRetry: (event) => retries.push(event.structuredError.message),
  });
  await executor.run();
  expect(entered).toBe(2);
  expect(retries).toEqual(['SYNTHETIC-stage']);
  const calls = events.filter(({ record }) => record.kind === 'call');
  expect(calls.map(({ record }) => [record.outcome, record.category])).toEqual([
    ['failed', 'server'],
    ['ok', undefined],
  ]);
  for (const call of calls) {
    expect(call).not.toHaveProperty('structuredError');
    expect(call.record).not.toHaveProperty('error');
  }
  return {
    address: { logRunId: executor.getSnapshot().runId, drillPath: [] },
    entries: sink.entries,
    selected: idOf(calls[0].record),
  };
}

it('reads the authorized exact call and keeps neighboring outcomes independent', async () => {
  const first = await recoveredRecording('first');
  const other = await recoveredRecording('other');
  const dir = await mkdtemp(join(tmpdir(), 'fp-classified-read-'));
  const writeRecording = async (name: string, entries: readonly RecordEntry[]) => {
    const path = join(dir, name);
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    return path;
  };

  try {
    const path = await writeRecording('full.ndjson', [...first.entries, ...other.entries]);
    const grants = [first.address, other.address];
    const log = await readScope(path, grants, first.address);
    if (!log) throw new Error('Expected the authorized log');
    expect(log.complete).toBe(true);
    expect(attemptRows(log).map((record) => [record.kind, record.outcome, record.error?.message])).toEqual([
      ['observed', 'failed', 'SYNTHETIC-sibling'],
      ['call', 'failed', undefined],
      ['stage', 'failed', 'SYNTHETIC-stage'],
      ['call', 'ok', undefined],
      ['stage', 'ok', undefined],
    ]);
    const sibling = attemptRows(log)[0];
    expect(sibling.target).toBe(target);
    expect(callOutcome(log, idOf(sibling))).toEqual(unavailable);
    expect(callOutcome(log, first.selected)).toEqual({
      status: 'available',
      attemptId: first.selected,
      outcome: 'failed',
      category: 'server',
    });
    const otherLog = await readScope(path, grants, other.address);
    expect(callOutcome(otherLog, other.selected)).toMatchObject({ status: 'available' });
    expect(callOutcome(log, other.selected)).toEqual(unavailable);

    // Retain the start and neighboring outcomes in a file without any terminal call rows for this log.
    const withoutEnd = first.entries.filter(
      (entry) =>
        !(entry.kind === 'note' && entry.note === 'attempt' && (entry.data.record as AttemptRecord).kind === 'call'),
    );
    expect(withoutEnd).toHaveLength(first.entries.length - 2);
    const partial = await writeRecording('start-only.ndjson', [...withoutEnd, ...other.entries]);
    const partialLog = await readScope(partial, grants, first.address);
    if (!partialLog) throw new Error('Expected the log with a surviving start');
    expect(
      partialLog.notes.some(
        (note) =>
          note.kind === 'attempt-start' &&
          note.data.series === first.selected.slice(0, first.selected.lastIndexOf('@')),
      ),
    ).toBe(true);
    expect(attemptRows(partialLog).map((record) => record.kind)).toEqual(['observed', 'stage', 'stage']);
    expect(callOutcome(partialLog, first.selected)).toEqual(unavailable);

    // The same request also sees the fixed gap when host policy withholds the log.
    const audienceGrants = [other.address];
    const withheld = await readScope(path, audienceGrants, first.address);
    const absent = await readScope(partial, audienceGrants, first.address);
    expect(withheld).toBeUndefined();
    expect(absent).toBeUndefined();
    const bytes = (log: StoredLog | undefined) => JSON.stringify(callOutcome(log, first.selected));
    expect(bytes(withheld)).toBe(bytes(absent));
    expect(bytes(withheld)).toBe(bytes(partialLog));
    expect(callOutcome(await readScope(path, audienceGrants, other.address), other.selected)).toMatchObject({
      status: 'available',
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});
