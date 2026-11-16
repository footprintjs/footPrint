import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';

import { readRunEvidence, readStoredRecord } from 'foottrace';
import { expect, it } from 'vitest';

import { readRecordFile } from '../../sinks/fileSink.js';

it.skipIf(process.platform === 'win32')(
  'keeps committed decisions and the entered mount after SIGKILL while the running leaf stays unknown',
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'footprint-s3-kill-'));
    const path = join(folder, 'run.jsonl');
    const fixture = fileURLToPath(new URL('./crash.fixture.mjs', import.meta.url));
    const bundle = join(folder, 'child.cjs');
    try {
      buildSync({
        entryPoints: [fixture],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent',
      });
      const child = spawnSync(process.execPath, [bundle, path], { encoding: 'utf8', timeout: 10000 });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBe('SIGKILL');
      const file = readRecordFile(path);
      expect(file.unreadable).toEqual([]);
      const record = readStoredRecord(file.entries);
      const rootId = file.entries.find((entry) => entry.kind === 'opened').address.logRunId;
      const run = readRunEvidence(record, rootId);
      expect(record.root(rootId).complete).toBe(false);
      expect(run.unread).toEqual([]);
      expect(run.decisions.rows).toMatchObject([{ id: 'route#1', chosen: 'Child' }]);
      expect(run.running.rows).toMatchObject([{ id: 'child#2' }]);
      expect(run.stages.rows.some((row) => row.id.includes('blocked'))).toBe(false);
      expect(run.stops.rows).toEqual([]);
      expect(file.entries.some((entry) => entry.kind === 'closed')).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  15000,
);
