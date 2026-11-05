import { describe, expect, it } from 'vitest';

import type { NativeFact, Receipt, ValueFact } from '../readWitness.js';
import { readRetention124 } from './index.js';
import type { JoinedRun, ReadPair, RetentionFact } from './types.js';

const missing: ValueFact = { kind: 'undefined' };
const stale: ValueFact = { kind: 'array', value: 0, entries: [] };
function fixture() {
  const make = (build: boolean): JoinedRun => {
    const header = { stageId: 's0', runId: build ? 'candidate' : 'reference', runtimeStageId: 's0#0' };
    const events: NativeFact[] = [
      {
        id: 1,
        start: 1,
        end: 2,
        leg: 'run',
        method: 'delete',
        outcome: 'returned',
        phase: 'write',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
      },
      {
        id: 3,
        start: 3,
        end: 6,
        leg: 'run',
        method: 'getValue',
        outcome: 'returned',
        phase: 'read',
        frame: 1,
        header,
        result: build ? missing : stale,
        gets: [4],
      },
      {
        id: 4,
        start: 4,
        end: 5,
        leg: 'run',
        method: 'get',
        outcome: 'returned',
        phase: 'read',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
        result: missing,
        base: { found: true, value: stale },
      },
    ];
    events.push({
      id: 11,
      start: 11,
      end: 14,
      leg: 'run',
      method: 'commit',
      outcome: 'returned',
      phase: 'commit',
      frame: 1,
      header,
      buffer: 1,
      epoch: 0,
      encoder: { method: 'toChangeOnlyPayload', start: 12, end: 13, bytes: 'same', mode: 'full' },
    });
    for (const event of events)
      Object.assign(event, { tier: event.method === 'getValue' ? 'stage-call' : 'buffer-call' });
    Object.assign(events[1], { operation: ['nested', 0, 1] });
    return {
      kept: { reads: build ? 'null' : '[]', state: '{"other":1}', commitLog: '[]', errors: '' },
      commits: [{ bytes: 'same', foldsBack: true, nativeId: 11 }],
      program: '{"sameProgram":true}',
      native: { leg: 'run', events, issues: [] },
    };
  };
  const bound = { coordinate: ['nested', 0, 1], frame: 1, nativeId: 3, start: 2, end: 7 };
  const pair: ReadPair = { baseline: bound, build: bound, sites: [{ kind: 'read-line', line: 0 }] };
  return { a: make(false), b: make(true), pair };
}
const verdict = ({ a, b, pair }: ReturnType<typeof fixture>) => readRetention124(a, b, [pair]);

describe('named #124 read-only retained relation — inert proof records, not native execution', () => {
  it('admits only the joined nullish delivered read while every commit/state/error byte remains exact', () => {
    expect(verdict(fixture())).toEqual({
      kind: 'related',
      name: 'read-after-delete-124',
      coordinates: [['nested', 0, 1]],
    });
  });
  it.each(['state', 'commitLog', 'errors', 'cp1'])('rejects an extra %s difference beside a valid read', (field) => {
    const f = fixture();
    f.b = { ...f.b, kept: { ...f.b.kept, [field]: 'corruption' } };
    expect(verdict(f).kind).toBe('unproven');
  });
  it('refuses changed commits, a non-folding build, stale return and an unjoined operation', () => {
    for (const damage of [
      (f: ReturnType<typeof fixture>) => {
        f.b = { ...f.b, commits: [{ bytes: 'different', foldsBack: true }] };
      },
      (f: ReturnType<typeof fixture>) => {
        f.b = { ...f.b, commits: [{ bytes: 'same', foldsBack: false }] };
      },
      (f: ReturnType<typeof fixture>) => {
        (f.b.native.events[1] as any).result = stale;
      },
      (f: ReturnType<typeof fixture>) => {
        f.pair = { ...f.pair, build: { ...f.pair.build, frame: 2 } };
      },
    ]) {
      const f = fixture();
      damage(f);
      expect(verdict(f).kind).toBe('unproven');
    }
  });
  it.each(['leg', 'namespace', 'key', 'before', 'reestablished', 'missing'])('refuses %s evidence', (kind) => {
    const f = fixture();
    const events = f.b.native.events as NativeFact[];
    if (kind === 'leg') f.b = { ...f.b, native: { ...f.b.native, leg: 'resume' } };
    if (kind === 'namespace') (events[2] as any).address = ['runs', 'other', 'x'];
    if (kind === 'key') (events[2] as any).address = ['y'];
    if (kind === 'before') (events[0] as any).end = 8;
    if (kind === 'reestablished')
      events.splice(1, 0, {
        ...events[0],
        id: 9,
        start: 2.1,
        end: 2.2,
        method: 'set',
        value: { kind: 'number', value: '9' },
      });
    if (kind === 'missing') events.splice(0, 1);
    expect(verdict(f).kind).toBe('unproven');
  });
  it('compares the unchanged prefix, and refuses an independent native return difference', () => {
    const f = fixture();
    const ordinary: NativeFact = {
      id: 8,
      start: 8,
      end: 9,
      leg: 'run',
      method: 'getValue',
      outcome: 'returned',
      phase: 'read',
      frame: 1,
      header: { stageId: 's0', runId: 'any', runtimeStageId: 's0#0' },
      result: { kind: 'number', value: '1' },
      gets: [],
    };
    Object.assign(ordinary, { tier: 'stage-call' });
    (f.a.native.events as NativeFact[]).push(ordinary);
    (f.b.native.events as NativeFact[]).push({ ...ordinary, result: { kind: 'number', value: '2' } });
    expect(verdict(f).kind).toBe('unproven');
  });
  it('joins a retained stage leaf to the actual native retention object, never a marker alone', () => {
    const f = fixture();
    const old: RetentionFact = {
      nativeId: 3,
      frame: 1,
      key: 'x',
      value: { kind: 'string', value: '[REDACTED]' },
      eligibility: { layout: 'baseline-own-readTracking', mode: 'full' },
    };
    const now: RetentionFact = {
      nativeId: 3,
      frame: 1,
      key: 'x',
      value: missing,
      eligibility: { layout: 'build-own-policy', mode: 'full' },
    };
    Object.assign(f.a.native.events[1], { retention: old });
    Object.assign(f.b.native.events[1], { retention: now });
    const tree = (value: string) =>
      JSON.stringify({ id: 's0', runtimeStageId: 's0#0', stageReads: { x: value }, other: 7 });
    f.a = { ...f.a, kept: { state: '{}', executionTree: tree('[REDACTED]') } };
    f.b = { ...f.b, kept: { state: '{}', executionTree: tree('«undefined»') } };
    f.pair = {
      ...f.pair,
      sites: [{ kind: 'stage-read', field: 'executionTree', nodePath: [], baseline: old, build: now }],
    };
    const beforeA = JSON.stringify(f.a.kept);
    const beforeB = JSON.stringify(f.b.kept);
    expect(verdict(f).kind).toBe('related');
    expect(JSON.stringify(f.a.kept)).toBe(beforeA);
    expect(JSON.stringify(f.b.kept)).toBe(beforeB);
    Object.assign(f.b.native.events[1], { retention: { ...now } });
    expect(verdict(f).kind).toBe('unproven');
  });
  it('refuses an OFF/unknown retention claim even when its pointer and marker match', () => {
    const f = fixture();
    const old: RetentionFact = {
      nativeId: 3,
      frame: 1,
      key: 'x',
      value: stale,
      eligibility: { layout: 'baseline-own-readTracking', mode: 'full' },
    };
    const now: RetentionFact = {
      nativeId: 3,
      frame: 1,
      key: 'x',
      value: missing,
      eligibility: { layout: 'build-own-policy', mode: 'full' },
    };
    Object.assign(f.a.native.events[1], { retention: old });
    Object.assign(f.b.native.events[1], { retention: now });
    const tree = (value: unknown) => JSON.stringify({ id: 's0', runtimeStageId: 's0#0', stageReads: { x: value } });
    f.a = { ...f.a, kept: { executionTree: tree([]) } };
    f.b = { ...f.b, kept: { executionTree: tree('«undefined»') } };
    f.pair = {
      ...f.pair,
      sites: [{ kind: 'stage-read', field: 'executionTree', nodePath: [], baseline: old, build: now }],
    };
    expect(verdict(f).kind).toBe('related');
    Object.assign(now.eligibility, { mode: 'off' });
    expect(verdict(f).kind).toBe('unproven');
  });
  it('requires the stale baseline return to equal the actual pre-delete native base', () => {
    const f = fixture();
    Object.assign(f.a.native.events[1], { result: { kind: 'number', value: '42' } });
    f.a = { ...f.a, kept: { ...f.a.kept, reads: '42' } };
    expect(verdict(f).kind).toBe('unproven');
  });
  it('requires each identical outer commit to equal its actual inner encoder output', () => {
    const f = fixture();
    const native = f.b.native.events.find((event) => event.method === 'commit')!;
    Object.assign(native.encoder!, { bytes: 'native independent difference hidden by an outer wrapper' });
    expect(verdict(f).kind).toBe('unproven');
  });
  it('does not claim an identical commit with a missing or foreign native receiver join', () => {
    const f = fixture();
    f.b = { ...f.b, commits: [{ ...f.b.commits[0], nativeId: 99 }] };
    expect(verdict(f).kind).toBe('unproven');
  });
  it('never normalizes arbitrary JSON text or admits a stale listed entry that stopped changing', () => {
    const f = fixture();
    f.a = { ...f.a, kept: { ...f.a.kept, reads: '[ ]' } };
    expect(verdict(f).kind).toBe('unproven');
    const same = fixture();
    same.a = { ...same.a, kept: { ...same.b.kept } };
    expect(verdict(same).kind).toBe('unproven');
  });
});
