import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileSink, readRecordFile } from './fileSink.js';

describe('file sink run-evidence fields', () => {
  it('keeps the writer manifest, commit annotations and note count beside unchanged bundles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'footprint-run-evidence-'));
    const path = join(directory, 'record.jsonl');
    const sink = fileSink(path);
    const address = { logRunId: 'run-evidence-file', drillPath: [] };
    const collects = { v: 1, reads: 'keys' };
    const about = { parent: 'seed#0', reads: ['score'] };
    const bundle = {
      idx: 0,
      stage: 'Route',
      stageId: 'route',
      runtimeStageId: 'route#1',
      overwrite: {},
      updates: {},
      trace: [],
    };
    const data = { seq: 1, id: 'route#1', by: 'plain', chosen: 'Accept' };
    try {
      await sink.opened({ address, at: 1, initialState: {}, collects });
      await sink.commit({ address, at: 2, bundle, about });
      await sink.note({ address, at: 3, kind: 'run.decision', data });
      await sink.closed({ address, at: 4, outcome: 'ok', commits: 1, runNotes: 1 });
      await sink.flush();
      const { entries, unreadable } = readRecordFile(path);
      expect(unreadable).toEqual([]);
      expect(entries.map((entry) => entry.kind)).toEqual(['opened', 'commit', 'note', 'closed']);
      expect(entries[0].collects).toEqual(collects);
      expect(entries[1].about).toEqual(about);
      expect(entries[1].bundle).toEqual(bundle);
      expect(entries[2].data).toEqual(data);
      expect(entries[3].runNotes).toBe(1);
    } finally {
      await sink.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('does not invent evidence fields for an older writer or an observed zero-note run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'footprint-run-evidence-'));
    const path = join(directory, 'record.jsonl');
    const sink = fileSink(path);
    const address = { logRunId: 'legacy-file', drillPath: [] };
    try {
      await sink.opened({ address, at: 1, initialState: {} });
      await sink.closed({ address, at: 2, outcome: 'ok', commits: 0 });
      await sink.closed({ address, at: 3, outcome: 'ok', commits: 0, runNotes: 0 });
      await sink.flush();
      const { entries, unreadable } = readRecordFile(path);
      expect(unreadable).toEqual([]);
      expect(entries[0]).not.toHaveProperty('collects');
      expect(entries[1]).not.toHaveProperty('runNotes');
      expect(entries[2]).toHaveProperty('runNotes', 0);
    } finally {
      await sink.close();
      rmSync(directory, { recursive: true });
    }
  });
});
