import { EventLog, memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { resolveRecordSink, RunRecord } from './recordSink.js';
import { recordCollects } from './recordEvidence.js';

describe('run record evidence configuration', () => {
  it.each([
    ['onFailure', 'other', "FlowChartExecutor: sink.onFailure must be 'report' or 'fail'"],
    ['flush', 'other', "FlowChartExecutor: sink.flush must be 'auto' or 'manual'"],
    ['evidence', 'other', "FlowChartExecutor: sink.evidence must be 'off' or omitted"],
  ])('preserves the %s refusal message', (name, value, message) => {
    expect(() => resolveRecordSink({ adapter: memorySink(), [name]: value })).toThrow(new TypeError(message));
  });

  it.each(['full', 'summary'])('declares read keys for %s tracking by default', (tracking) => {
    const resolved = resolveRecordSink(memorySink());
    expect(recordCollects(resolved, tracking)).toEqual({ reads: 'keys' });
  });

  it('declares no read collection when tracking is off', () => {
    const resolved = resolveRecordSink({ adapter: memorySink() });
    expect(recordCollects(resolved, 'off')).toEqual({ reads: 'off' });
  });

  it('leaves the writer inert when evidence is explicitly off', () => {
    const sink = memorySink();
    const resolved = resolveRecordSink({ adapter: sink, evidence: 'off' });
    const record = new RunRecord(resolved);
    expect(recordCollects(resolved, 'full')).toBeUndefined();
    const log = new EventLog(
      {},
      {
        sink: record.sink,
        address: { logRunId: 'evidence-off', drillPath: [] },
        collects: recordCollects(resolved, 'full'),
      },
    );
    log.close('ok');
    expect(log.keepsEvidence).toBe(false);
    expect(sink.entries[0]).not.toHaveProperty('collects');
    expect(sink.entries[1]).not.toHaveProperty('runNotes');
  });

  it('passes the declared manifest and an explicit zero-note count through the real writer', () => {
    const sink = memorySink();
    const resolved = resolveRecordSink(sink);
    const record = new RunRecord(resolved);
    const log = new EventLog(
      {},
      {
        sink: record.sink,
        address: { logRunId: 'evidence-on', drillPath: [] },
        collects: recordCollects(resolved, 'full'),
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
    const resolved = resolveRecordSink(option);
    expect(recordCollects(resolved, 'full')).toBeUndefined();
    expect(recordCollects(resolved, 'summary')).toBeUndefined();
    expect(reads).toBe(1);
  });
});
