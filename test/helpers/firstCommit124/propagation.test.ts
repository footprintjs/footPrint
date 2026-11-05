/** Inert rule controls only: no native source runs and no recording is changed by the proof. */
import { describe, expect, it } from 'vitest';

import type { NativeFact } from '../readWitness.js';
import { firstCommit124 } from './index.js';
import { array, copyBatch, mergeReadAll, number, preludeReadAll, U } from './propagationFixture.js';

type Fixture = ReturnType<typeof copyBatch>;
const judge = (f: Fixture) => firstCommit124(f.a, f.b, f.cause, 'chart');
const stage = (f: Fixture, side: 'a' | 'b', op: number, method = 'getValue') =>
  f[side].native.events.find(
    (row) => row.tier === 'stage-call' && row.operation?.at(-1) === op && row.method === method,
  )!;
const physical = (f: Fixture, side: 'a' | 'b', op: number) =>
  f[side].native.events.find(
    (row) => row.tier === 'buffer-call' && row.operation?.at(-1) === op && row.phase === 'write',
  )!;
const restamp = (f: Fixture, side: 'a' | 'b', value: unknown) => {
  const commit = f.cause[side === 'a' ? 'baselineCommit' : 'buildCommit'];
  Object.assign(commit.encoder, { bytes: JSON.stringify({ overwrite: value, updates: {}, trace: [] }) });
  Object.assign(f[side].commits[0], { bytes: commit.encoder.bytes });
};
describe('same FIRST cause, explicit operation propagation', () => {
  it('joins the copy destination and BOTH declared batch writes without changing original evidence', () => {
    const f = copyBatch();
    const before = JSON.stringify(f);
    expect(judge(f)).toMatchObject({
      kind: 'cause',
      name: 'read-after-delete-124',
      propagation: [
        { fromAddress: ['list'], toAddress: ['obj'], baselineIdentity: 7, via: 'copy' },
        { fromAddress: ['obj'], toAddress: ['obj'], baselineIdentity: 7, via: 'branch', buildValue: array(number(2)) },
      ],
    });
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each([false, true])('joins a native new-root read to OWN record, accounted tail=%s', (tail) => {
    const f = mergeReadAll(tail);
    expect(judge(f)).toMatchObject({
      kind: 'cause',
      propagation: expect.arrayContaining([
        expect.objectContaining({
          via: 'native-producer-readback',
          baselineIdentity: 8,
          fromAddress: ['obj'],
          toAddress: ['obj'],
          buildValue: U,
        }),
      ]),
    });
  });
  it('retains the earlier deleted hist slot and separately names earliest read and first write', () => {
    const f = preludeReadAll();
    expect(judge(f)).toMatchObject({
      kind: 'cause',
      readOperation: f.a.operations![0].coordinate,
      writeOperation: f.cause.baseline.operation.coordinate,
      propagation: [{ via: 'read-only-prelude', baselineIdentity: 7, fromAddress: ['hist'], toAddress: ['hist'] }],
    });
  });
  it.each([
    'copy-source',
    'copy-clone',
    'batch-argument',
    'intervening-destination',
    'unrelated-prefix',
    'missing-operation',
    'duplicate-read-id',
    'wrong-address',
    'extra-row',
    'fold-back',
    'encoder',
  ])('refuses %s beside a valid explicit copy chain', (damage) => {
    const f = copyBatch();
    if (damage === 'copy-source') Object.assign(f.cause.baseline.calls[0].call.args[1], { value: 'a' });
    if (damage === 'copy-clone')
      Object.assign(f.cause.baseline.calls[1].call, { objects: [101, undefined, 99, undefined, undefined] });
    if (damage === 'batch-argument') Object.assign(stage(f, 'a', 2, 'setObject').call!.args[2], { value: 99 });
    if (damage === 'intervening-destination') {
      const p = physical(f, 'a', 1);
      const read = stage(f, 'a', 2);
      (f.a.native.events as NativeFact[]).push({ ...p, id: 999, start: p.end + 0.1, end: read.start - 0.1 });
    }
    if (damage === 'unrelated-prefix') {
      for (const side of ['a', 'b'] as const) {
        const p = f[side].native.events[0];
        (f[side].native.events as NativeFact[]).unshift({
          ...p,
          id: 999,
          start: 0.1,
          end: 0.2,
          method: 'set',
          value: number(side === 'a' ? 1 : 2),
          address: ['a'],
        });
      }
    }
    if (damage === 'missing-operation') Object.assign(f.b, { operations: f.b.operations!.slice(0, 1) });
    if (damage === 'duplicate-read-id') {
      const read = stage(f, 'a', 2);
      const events = f.a.native.events as NativeFact[];
      events.push({ ...read });
    }
    if (damage === 'wrong-address') Object.assign(physical(f, 'a', 2), { address: ['b'] });
    if (damage === 'extra-row') {
      const read = stage(f, 'a', 2);
      (f.a.native.events as NativeFact[]).push({ ...read, id: 999, start: read.end + 0.1, end: read.end + 0.2 });
    }
    if (damage === 'fold-back') Object.assign(f.b.commits[0], { foldsBack: false });
    if (damage === 'encoder') Object.assign(f.cause.buildCommit.encoder, { bytes: '{}' });
    expect(judge(f).kind).toBe('unproven');
  });
  it.each(['record-value', 'merge-input', 'later-clone', 'later-unaccounted', 'intervening', 'wrong-read-get'])(
    'refuses %s for native-produced roots',
    (damage) => {
      const f = mergeReadAll(true);
      const read = f.a.native.events.find((row) => row.operation?.at(-1) === 2 && row.resultObject === 8)!;
      if (damage === 'record-value') restamp(f, 'a', { obj: { n: 99 } });
      if (damage === 'merge-input') Object.assign(physical(f, 'a', 1), { valueObject: 99 });
      if (damage === 'later-clone') Object.assign(physical(f, 'a', 3), { valueObject: 99 });
      if (damage === 'later-unaccounted') {
        const later = physical(f, 'a', 3);
        (f.a.native.events as NativeFact[]).push({ ...later, id: 999, start: later.end + 0.1, end: later.end + 0.2 });
      }
      if (damage === 'intervening') {
        const producer = physical(f, 'a', 1);
        (f.a.native.events as NativeFact[]).push({
          ...producer,
          id: 999,
          start: producer.end + 0.1,
          end: read.start - 0.1,
        });
      }
      if (damage === 'wrong-read-get')
        Object.assign(f.a.native.events.find((row) => row.id === read.gets![0])!, { result: U });
      expect(judge(f).kind).toBe('unproven');
    },
  );
  it.each(['other-slot', 'prior-identity', 're-established', 'other-key-argument'])(
    'never discards an earlier readAll %s',
    (damage) => {
      const f = preludeReadAll();
      const reads = f.a.native.events.filter((row) => row.tier === 'stage-call' && row.operation?.at(-1) === 1);
      if (damage === 'other-slot') Object.assign(reads[0], { result: number(99) });
      if (damage === 'prior-identity')
        Object.assign(reads[4], {
          resultObject: 99,
          resultIdentities: [
            { path: [], object: 99 },
            { path: ['0'], object: 8 },
          ],
        });
      if (damage === 're-established') {
        const old = f.a.native.events[0];
        (f.a.native.events as NativeFact[]).push({
          ...old,
          id: 999,
          start: reads[4].end + 0.1,
          end: f.cause.baseline.operation.start - 0.1,
          method: 'set',
          value: U,
        });
      }
      if (damage === 'other-key-argument') Object.assign(reads[1].call!.args[1], { value: 'a' });
      expect(judge(f).kind).toBe('unproven');
    },
  );
});
