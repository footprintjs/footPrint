/**
 * A hard kill mid-retry leaves the attempt notes (design §3.5, the threat model of packet P6).
 *
 * WHY: the record of a run that never finished is the one an incident needs, and attempts never ride a commit
 * (Q1) — a stage that was killed between its attempts never commits at all. So each attempt is noted in the sink as
 * it ENDS, before the next one starts. This test kills a real Node process with SIGKILL during attempt 2 of a
 * retried stage and reads its file: the root log is not complete, the first stage's commit is there, and attempt 1
 * of the killed stage is there with its outcome and its decision to retry.
 *
 * Test types: Scenario (a separate process, SIGKILL — no finally, no flush, no closing entry) · Integration (the
 * file sink, `readRecordFile`, `readStoredRecord` and `stateAt` over what the dead process left).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildSync } from 'esbuild';
import { readStoredRecord, stateAt } from 'foottrace';
import { afterAll, describe, expect, it } from 'vitest';

import { readRecordFile } from '../../../../src/sinks.js';

const dir = mkdtempSync(join(tmpdir(), 'fp-hard-kill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a process killed mid-retry', () => {
  const bundle = join(dir, 'child.cjs');
  buildSync({
    entryPoints: [resolve(__dirname, '../fixtures/killed-mid-retry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  });

  // The file sink writes asynchronously (coordinator ruling): each accepted entry is handed to the I/O pool at once,
  // at its own offset, and the pool's thread performs it while the main thread runs on. A kill in the microseconds
  // before that thread runs can lose the newest entry — so the proof uses realistic retry waits. (With no wait at all
  // the notes survived 30/30 standalone kills; under heavy parallel load the window shows — named in the guide.)
  it.each([
    ['a 100 ms backoff', 100],
    ['a 20 ms backoff', 20],
  ])(
    'leaves its record — incomplete, the landed commit, attempt 1 with its decision to retry: %s',
    (_name, backoff) => {
      const file = join(dir, `record-${String(_name).replace(/\W+/g, '-')}.jsonl`);
      const child = spawnSync(process.execPath, [bundle, file, String(backoff)], { encoding: 'utf8', timeout: 20_000 });
      expect(child.signal).toBe('SIGKILL');
      const read = readRecordFile(file);
      expect(read.unreadable).toEqual([]);
      const record = readStoredRecord(read.entries);
      const [root] = [...record.logs.values()];
      expect(root.address.drillPath).toEqual([]);

      // The run never ended: no closing entry, so the reader says so before anything is folded.
      expect(root.complete).toBe(false);
      expect(root.outcome).toBeUndefined();

      // What landed is there: the first stage's commit — and it folds.
      expect(root.commitLog).toHaveLength(1);
      expect(root.gaps).toEqual([]);
      expect(stateAt(root.source(), 0).state).toEqual({ orderId: 'A-17' });

      // The killed stage never committed — its attempt is the evidence: attempt 1 failed, the series chose to retry.
      const attempts = root.notes.filter((n) => n.kind === 'attempt').map((n) => (n.data as any).record);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        kind: 'stage',
        attempt: 1,
        of: 3,
        outcome: 'failed',
        category: 'server',
        next: 'retry',
        error: { message: 'gateway busy' },
      });
      expect(attempts[0].series).toMatch(/^charge#\d+$/);
    },
    30_000,
  );
});
