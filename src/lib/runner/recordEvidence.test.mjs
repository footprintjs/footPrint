import { EventLog, memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { resolveRecordSink, RunRecord } from './recordSink.js';

describe('run record evidence configuration', () => {
  it.each(['full', 'summary'])('declares read keys for %s tracking by default', (tracking) => {
    const record = new RunRecord(resolveRecordSink(memorySink()));
    expect(record.collects(tracking)).toEqual({ reads: 'keys' });
  });

  it('declares no read collection when tracking is off', () => {
    const record = new RunRecord(resolveRecordSink({ adapter: memorySink() }));
    expect(record.collects('off')).toEqual({ reads: 'off' });
  });

  it('leaves the writer inert when evidence is explicitly off', () => {
    const sink = memorySink();
    const record = new RunRecord(resolveRecordSink({ adapter: sink, evidence: 'off' }));
    expect(record.collects('full')).toBeUndefined();
    const log = new EventLog(
      {},
      {
        sink: record.sink,
        address: { logRunId: 'evidence-off', drillPath: [] },
        collects: record.collects('full'),
      },
    );
    log.close('ok');
    expect(log.keepsEvidence).toBe(false);
    expect(sink.entries[0]).not.toHaveProperty('collects');
    expect(sink.entries[1]).not.toHaveProperty('runNotes');
  });

  it('passes the declared manifest and an explicit zero-note count through the real writer', () => {
    const sink = memorySink();
    const record = new RunRecord(resolveRecordSink(sink));
    const log = new EventLog(
      {},
      {
        sink: record.sink,
        address: { logRunId: 'evidence-on', drillPath: [] },
        collects: record.collects('full'),
      },
    );
    log.close('ok');
    expect(log.keepsEvidence).toBe(true);
    expect(sink.entries[0].collects).toEqual({ v: 1, reads: 'keys' });
    expect(sink.entries[1].runNotes).toBe(0);
  });

  it.each([null, false, true, 'on', 'keys', 0, {}])('refuses invalid evidence option %j', (evidence) => {
    expect(() => resolveRecordSink({ adapter: memorySink(), evidence })).toThrow(/evidence/);
  });

  it('samples and fixes the option once at construction', () => {
    let reads = 0;
    const option = {
      adapter: memorySink(),
      get evidence() {
        reads++;
        return reads === 1 ? 'off' : undefined;
      },
    };
    const record = new RunRecord(resolveRecordSink(option));
    expect(record.collects('full')).toBeUndefined();
    expect(record.collects('summary')).toBeUndefined();
    expect(reads).toBe(1);
  });
});
