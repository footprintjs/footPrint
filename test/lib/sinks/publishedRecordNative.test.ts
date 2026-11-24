import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogAddress } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { expect, it } from 'vitest';

import { openPublishedRecordFile } from '../../../src/lib/sinks/publishedRecordFile.js';
import { indexedFileSink } from '../../../src/lib/sinks/publishedRecordWriter.js';

it('never serves a missing native commit as whole evidence even when every range was read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-published-native-'));
  const payload = join(directory, 'record.jsonl');
  const index = join(directory, 'index.json');
  const audience = 'local';
  const address: LogAddress = { logRunId: 'root', drillPath: [] };
  const sink = indexedFileSink(payload, { audience });
  try {
    const initialState = { source: 'opened' };
    const log = new EventLog(initialState, {
      address,
      sink: {
        ...sink,
        commit(entry) {
          if (entry.bundle.idx > 0) return sink.commit(entry);
        },
      },
    });
    const memory = new SharedMemory(undefined, initialState);
    for (let index = 0; index < 2; index++) {
      new RecordFrame(memory, log).commit(() => ({
        stage: 'Native stage',
        stageId: 'native',
        runtimeStageId: `native#${index}`,
      }));
    }
    log.close('ok');
    const publication = await sink.seal(index);
    const opened = await openPublishedRecordFile(payload, index, publication, { audience, allowedScopes: [address] });
    if (opened.status !== 'ready') throw new Error(`Published recording refused: ${opened.reason}`);
    try {
      expect(await opened.reader.readState(address, -1)).toMatchObject({
        status: 'loaded',
        state: { basis: 'initial+log', throughCommitIdx: -1, state: initialState },
      });
      expect(await opened.reader.readState(address, 1)).toEqual({ status: 'unknown', reason: 'unavailable' });
      expect(await opened.reader.readState(address, 2)).toEqual({ status: 'unknown', reason: 'unavailable' });
      expect(await opened.reader.readScope(address)).toEqual({ status: 'unknown', reason: 'unavailable' });
    } finally {
      await opened.reader.close();
    }
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
