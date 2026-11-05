/** Inert original-reference constructors only; no engine execution or pointer revival. */
import { describe, expect, it } from 'vitest';

import { requireOwnStagedRead } from './recordValue.js';

const value = { kind: 'object', entries: [['n', true, { kind: 'number', value: '1' }]] };
function fixture() {
  const address = ['runs', 'child', 'obj'];
  const base = {
    tier: 'buffer-call',
    leg: 'run',
    outcome: 'returned',
    frame: 1,
    buffer: 2,
    epoch: 0,
    header: { stageId: 's', runId: '', runtimeStageId: 's#0' },
  };
  const tomb: any = {
    ...base,
    id: 1,
    start: 1,
    end: 2,
    method: 'set',
    phase: 'write',
    address,
    value: { kind: 'undefined' },
  };
  const producer: any = {
    ...base,
    id: 3,
    start: 3,
    end: 4,
    method: 'merge',
    phase: 'write',
    address,
    value,
    valueObject: 7,
  };
  const get: any = {
    ...base,
    id: 7,
    start: 7,
    end: 8,
    method: 'get',
    phase: 'read',
    address,
    result: value,
    base: { found: false, value: { kind: 'undefined' } },
  };
  const read: any = {
    ...base,
    tier: 'stage-call',
    id: 6,
    start: 6,
    end: 9,
    method: 'getValue',
    phase: 'read',
    gets: [7],
    result: value,
    resultObject: 8,
  };
  const later: any = {
    ...base,
    id: 10,
    start: 10,
    end: 11,
    method: 'set',
    phase: 'write',
    address,
    value,
    valueObject: 8,
  };
  const payload = { overwrite: { runs: { child: { obj: { n: 1 } } } }, updates: {}, trace: [] };
  const commit: any = {
    ...base,
    id: 12,
    start: 12,
    end: 15,
    method: 'commit',
    phase: 'commit',
    encoder: { method: 'toChangeOnlyPayload', mode: 'full', start: 13, end: 14, bytes: JSON.stringify(payload) },
  };
  const events: any[] = [tomb, producer, read, get, later, commit];
  const row = { nativeId: 12, foldsBack: true, bytes: commit.encoder.bytes };
  const run: any = { program: '{}', native: { leg: 'run', events, issues: [] }, commits: [row], kept: {} };
  const context: any = {
    a: run,
    b: run,
    index: 0,
    cause: { baselineCommit: commit, buildCommit: commit },
    reads: [{ deletedBy: tomb }, { deletedBy: tomb }],
  };
  const accepted = new Set<any>([producer, later]);
  const restamp = () => {
    commit.encoder.bytes = JSON.stringify(payload);
    row.bytes = commit.encoder.bytes;
  };
  const invoke = () => requireOwnStagedRead(context, 'baseline', read, get, producer, accepted);
  return { context, read, get, producer, tomb, later, commit, events, payload, row, accepted, restamp, invoke };
}
describe('own staged record readback proof', () => {
  it('joins a new native read root to its own exact staged value and accounted later SAME-root write', () => {
    const f = fixture();
    const before = JSON.stringify(f.context);
    expect(f.invoke).not.toThrow();
    expect(JSON.stringify(f.context)).toBe(before);
  });
  it('accepts a native delta slot beside an explicitly proved original tombstone', () => {
    const f = fixture();
    (f.payload.overwrite.runs.child as any).obj = '«undefined»';
    (f.payload.updates as any).runs = { child: { obj: { n: 1 } } };
    f.commit.encoder.mode = 'delta';
    f.commit.encoder.method = 'toDeltaPayload';
    f.restamp();
    expect(f.invoke).not.toThrow();
  });
  it('accepts final payload with no later producer when the read stands unchanged', () => {
    const f = fixture();
    f.events.splice(f.events.indexOf(f.later), 1);
    f.accepted.delete(f.later);
    expect(f.invoke).not.toThrow();
  });
  it('allows omitted undefined only from explicit original absent base plus its last tombstone', () => {
    const f = fixture();
    f.events.splice(f.events.indexOf(f.producer), 1);
    f.events.splice(f.events.indexOf(f.later), 1);
    f.read.result = { kind: 'undefined' };
    f.read.resultObject = undefined;
    f.get.result = f.read.result;
    f.payload.overwrite = {} as any;
    f.restamp();
    expect(() => requireOwnStagedRead(f.context, 'build', f.read, f.get, f.tomb, new Set([f.tomb]))).not.toThrow();
  });
  it.each([
    'forged-read',
    'forged-get',
    'forged-producer',
    'wrong-buffer',
    'wrong-epoch',
    'wrong-address',
    'missing-get-link',
    'wrong-get-result',
    'intervening-write',
    'numeric-string-overlap',
    'later-unaccounted',
    'later-clone',
    'later-changed-value',
    'wrong-record-value',
    'missing-record-slot',
    'ambiguous-record-slots',
    'opposite-not-tombstone',
    'opposite-wrong-owner',
    'encoder-outer-mismatch',
    'noncanonical-encoder',
  ])('refuses %s without temporal or equal-content inference', (damage) => {
    const f = fixture();
    let read = f.read;
    let get = f.get;
    let producer = f.producer;
    if (damage === 'forged-read') read = { ...read };
    if (damage === 'forged-get') get = { ...get };
    if (damage === 'forged-producer') producer = { ...producer };
    if (damage === 'wrong-buffer') f.get.buffer = 3;
    if (damage === 'wrong-epoch') f.get.epoch = 1;
    if (damage === 'wrong-address') f.get.address = ['other'];
    if (damage === 'missing-get-link') f.read.gets = [];
    if (damage === 'wrong-get-result') f.get.result = { kind: 'null' };
    if (damage === 'intervening-write') f.events.push({ ...f.producer, id: 5, start: 5, end: 5.5 });
    if (damage === 'numeric-string-overlap') {
      f.get.address.push('0');
      (f.payload.overwrite.runs.child as any).obj = { '0': { n: 1 } };
      f.events.push({ ...f.producer, address: [...f.get.address.slice(0, -1), 0], id: 5, start: 5, end: 5.5 });
    }
    if (damage === 'later-unaccounted') f.accepted.delete(f.later);
    if (damage === 'later-clone') f.later.valueObject = 99;
    if (damage === 'later-changed-value') f.later.value = { kind: 'null' };
    if (damage === 'wrong-record-value') f.payload.overwrite.runs.child.obj.n = 9;
    if (damage === 'missing-record-slot') f.payload.overwrite = {} as any;
    if (damage === 'ambiguous-record-slots') (f.payload.updates as any).runs = { child: { obj: { n: 1 } } };
    if (damage === 'opposite-not-tombstone') {
      (f.payload.overwrite.runs.child as any).obj = '«undefined»';
      (f.payload.updates as any).runs = { child: { obj: { n: 1 } } };
      f.tomb.value = { kind: 'string', value: '«undefined»' };
    }
    if (damage === 'opposite-wrong-owner') {
      (f.payload.overwrite.runs.child as any).obj = '«undefined»';
      (f.payload.updates as any).runs = { child: { obj: { n: 1 } } };
      f.tomb.epoch = 1;
    }
    f.restamp();
    if (damage === 'encoder-outer-mismatch') f.row.bytes = '{}';
    if (damage === 'noncanonical-encoder') {
      f.commit.encoder.bytes = ' ' + f.commit.encoder.bytes;
      f.row.bytes = f.commit.encoder.bytes;
    }
    expect(() => requireOwnStagedRead(f.context, 'baseline', read, get, producer, f.accepted)).toThrow();
  });
  it.each(['missing-base', 'base-present', 'no-tombstone'])('refuses omitted undefined with %s', (damage) => {
    const f = fixture();
    f.events.splice(f.events.indexOf(f.producer), 1);
    f.events.splice(f.events.indexOf(f.later), 1);
    f.read.result = { kind: 'undefined' };
    f.read.resultObject = undefined;
    f.get.result = f.read.result;
    f.payload.overwrite = {} as any;
    f.restamp();
    if (damage === 'missing-base') f.get.base = undefined;
    if (damage === 'base-present') f.get.base.found = true;
    if (damage === 'no-tombstone') f.tomb.value = { kind: 'null' };
    expect(() => requireOwnStagedRead(f.context, 'build', f.read, f.get, f.tomb, new Set([f.tomb]))).toThrow();
  });
});
