import { readRunEvidence, readStoredRecord } from 'foottrace';
import { EventLog, memorySink, RUN_EVIDENCE_LIMITS } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import {
  beginEvidence,
  discardEvidenceReads,
  noteEvidenceStage,
  recordEvidenceRead,
  registerEvidence,
  registerLogEvidence,
  takeEvidenceAbout,
} from './index.js';

function writer(reads = 'keys') {
  const sink = memorySink();
  const log = new EventLog({}, { sink, address: { logRunId: 'native-evidence', drillPath: [] }, collects: { reads } });
  registerLogEvidence(log, { reads });
  return { sink, log };
}

describe('native frame evidence', () => {
  it('does not infer a native declaration from an arbitrary already-open log', () => {
    const sink = memorySink();
    const log = new EventLog(
      {},
      { sink, address: { logRunId: 'unbound', drillPath: [] }, collects: { reads: 'keys' } },
    );
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, true);
    expect(takeEvidenceAbout(frame)).toBeUndefined();
  });

  it('does not relabel a continuing log when a later leg disables reads', () => {
    const { sink, log } = writer();
    registerLogEvidence(log, { reads: 'off' });
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, false);
    log.record(
      { stage: 'Stage', stageId: 'stage', runtimeStageId: 'stage#0', overwrite: {}, updates: {}, trace: [] },
      takeEvidenceAbout(frame),
    );
    log.close('ok');
    const evidence = readRunEvidence(readStoredRecord(sink.entries), 'native-evidence');
    expect(evidence.reads.status).toBe('partial');
    expect(evidence.reads.gaps).toContain('not-collected');
    expect(evidence.reads.rows).toEqual([]);
  });

  it('does nothing for a sinkless log without adding frame keys', () => {
    const frame = { native: true };
    const log = new EventLog({});
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, true);
    recordEvidenceRead(frame, [], 'secret-key');
    expect(takeEvidenceAbout(frame)).toBeUndefined();
    expect(Reflect.ownKeys(frame)).toEqual(['native']);
    expect(Reflect.ownKeys(log)).toEqual(Reflect.ownKeys(new EventLog({})));
  });

  it('preserves distinct first-read order, including integer-like names', () => {
    const { log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#1', parent: 'before#0' }, true);
    recordEvidenceRead(frame, [], '9');
    recordEvidenceRead(frame, [], '2');
    recordEvidenceRead(frame, [], '9');
    recordEvidenceRead(frame, [], 'other');
    expect(takeEvidenceAbout(frame)).toEqual({ parent: 'before#0', reads: ['9', '2', 'other'] });
    expect(takeEvidenceAbout(frame)).toBeUndefined();
  });

  it('deduplicates canonical paths and refuses an over-cap annotation honestly', () => {
    const { sink, log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, true);
    recordEvidenceRead(frame, [], 'a.b');
    recordEvidenceRead(frame, ['a'], 'b');
    const first = takeEvidenceAbout(frame);
    expect(first.reads).toHaveLength(2);
    expect(first.reads[0]).not.toBe(first.reads[1]);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, true);
    for (let i = 0; i < RUN_EVIDENCE_LIMITS.reads; i++) recordEvidenceRead(frame, [], `key${i}`);
    recordEvidenceRead(frame, ['a'], 'b');
    recordEvidenceRead(frame, [], 'a.b');
    recordEvidenceRead(frame, ['a'], 'b');
    const about = takeEvidenceAbout(frame);
    expect(about).toBeUndefined();
    log.record(
      { stage: 'Stage', stageId: 'stage', runtimeStageId: 'stage#0', overwrite: {}, updates: {}, trace: [] },
      about,
    );
    log.close('ok');
    const evidence = readRunEvidence(readStoredRecord(sink.entries), 'native-evidence');
    expect(evidence.reads.status).toBe('partial');
    expect(evidence.reads.gaps).toContain('not-collected');
    expect(evidence.reads.rows).toEqual([]);
    expect(sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.stage')).toHaveLength(1);
  });

  it('shares one stage edge between entry, repeated entry and over-cap refusal', () => {
    const { sink, log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#2', parent: 'mount#0', resumes: 'paused#1' }, true);
    noteEvidenceStage(frame);
    noteEvidenceStage(frame);
    for (let i = 0; i <= RUN_EVIDENCE_LIMITS.reads; i++) recordEvidenceRead(frame, [], `key${i}`);
    log.record(
      { stage: 'Stage', stageId: 'stage', runtimeStageId: 'stage#2', overwrite: {}, updates: {}, trace: [] },
      takeEvidenceAbout(frame),
    );
    noteEvidenceStage(frame);
    log.close('ok');
    const evidence = readRunEvidence(readStoredRecord(sink.entries), 'native-evidence');
    expect(evidence.unread).toEqual([]);
    expect(evidence.reads.status).toBe('partial');
    expect(evidence.reads.gaps).toContain('not-collected');
    const notes = sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.stage');
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toEqual({ seq: 0, id: 'stage#2', parent: 'mount#0', resumes: 'paused#1' });
  });

  it('bounds first-description metadata and leaves later descriptions absent', () => {
    const { log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    for (let i = 0; i < 1024; i++) {
      beginEvidence(frame, { stageId: `stage${i}`, id: `stage${i}#${i}`, description: 'known' }, true);
      expect(takeEvidenceAbout(frame).description).toBe('known');
    }
    beginEvidence(frame, { stageId: 'later', id: 'later#1024', description: 'not collected' }, true);
    expect(takeEvidenceAbout(frame)).not.toHaveProperty('description');
  });

  it('clears discarded attempt names while preserving native ancestry', () => {
    const { log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#1', parent: 'before#0', resumes: 'paused#0' }, true);
    recordEvidenceRead(frame, [], 'discarded');
    discardEvidenceReads(frame);
    recordEvidenceRead(frame, [], 'final');
    expect(takeEvidenceAbout(frame)).toEqual({ parent: 'before#0', resumes: 'paused#0', reads: ['final'] });
  });

  it('leaves read facts absent when the native read dial is disabled', () => {
    const { log } = writer('off');
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(frame, { stageId: 'stage', id: 'stage#0' }, false);
    recordEvidenceRead(frame, [], 'not-collected');
    expect(takeEvidenceAbout(frame)).toEqual({});
  });

  it('offers an already-served description once per stage and log', () => {
    const { log } = writer();
    const a = {},
      b = {};
    registerEvidence(a, log);
    registerEvidence(b, log);
    beginEvidence(a, { stageId: 'stage', id: 'stage#0', description: '[REDACTED]' }, true);
    expect(takeEvidenceAbout(a).description).toBe('[REDACTED]');
    beginEvidence(b, { stageId: 'stage', id: 'stage#1', description: 'later' }, true);
    expect(takeEvidenceAbout(b)).not.toHaveProperty('description');
    const other = writer();
    registerEvidence(b, other.log);
    beginEvidence(b, { stageId: 'stage', id: 'stage#0', description: 'other log' }, true);
    expect(takeEvidenceAbout(b).description).toBe('other log');
  });

  it('passes only annotation fields to the canonical writer and round-trips the read channel', () => {
    const { sink, log } = writer();
    const frame = {};
    registerEvidence(frame, log);
    beginEvidence(
      frame,
      { stageId: 'stage', id: 'stage#0', description: 'Read a key', unexpected: 'must not persist' },
      true,
    );
    recordEvidenceRead(frame, [], 'score');
    log.record(
      { stage: 'Stage', stageId: 'stage', runtimeStageId: 'stage#0', overwrite: {}, updates: {}, trace: [] },
      takeEvidenceAbout(frame),
    );
    log.close('ok');
    const stored = readStoredRecord(sink.entries);
    const evidence = readRunEvidence(stored, 'native-evidence');
    expect(evidence.reads.status).toBe('collected');
    expect(evidence.reads.rows).toHaveLength(1);
    expect(JSON.stringify(sink.entries)).not.toContain('must not persist');
  });
});
