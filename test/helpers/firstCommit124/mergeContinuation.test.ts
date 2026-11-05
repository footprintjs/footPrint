/** Adjacent inert WB bridge controls. Original cause.test assertions are unchanged. */
import { describe, expect, it } from 'vitest';

import type { JoinedRun, OperationRead, ReadPair } from '../readLawWitness.js';
import type { NativeFact, ValueFact } from '../readWitness.js';
import { firstCommit124 } from './index.js';
import type { BranchReceipt, Cause, CommitObservation, FixtureCall } from './types.js';

const missing: ValueFact = { kind: 'undefined' };
const number = (n: number): ValueFact => ({ kind: 'number', value: String(n) });
const array = (...values: ValueFact[]): ValueFact => ({
  kind: 'array',
  value: values.length,
  entries: values.map((value, i) => [String(i), true, value]),
});
const string = (value: string): ValueFact => ({ kind: 'string', value });
const stale = array(number(3));
const edited = array(number(3), number(9));
const path = array();
const coordinate = ['writeback', 0, 0] as const;
const program = JSON.stringify({
  commitValues: 'full',
  stages: [{ ops: [{ t: 'delReadBack', path: 0, k: 'x', n: 9, how: 'set' }] }],
});
function fixture() {
  const one = (build: boolean): { run: JoinedRun; branch: BranchReceipt; commit: CommitObservation } => {
    const header = { stageId: 's0', runId: build ? 'candidate' : 'baseline' };
    const common = { leg: 'run', frame: 1, header, outcome: 'returned' as const };
    const call = (id: number, end: number, method: string, args: ValueFact[]): FixtureCall => ({
      ...common,
      id,
      start: id,
      end,
      method,
      phase: method === 'getValue' ? 'read' : 'write',
      operation: coordinate,
      call: { args, objects: method === 'setObject' && id === 11 ? [undefined, undefined, 7] : [] },
    });
    const del = call(1, 4, 'setObject', [
      path,
      string('x'),
      missing,
      { kind: 'boolean', value: false },
      missing,
      string('delete'),
    ]);
    const read = Object.assign(call(5, 8, 'getValue', [path, string('x')]), {
      result: build ? missing : stale,
      resultObject: build ? undefined : 7,
      gets: [6],
    });
    const write = call(11, 14, 'setObject', [path, string('x'), edited]);
    const mutation: NativeFact = {
      ...common,
      id: 2,
      start: 2,
      end: 3,
      method: 'delete',
      phase: 'write',
      buffer: 1,
      epoch: 0,
      address: ['x'],
    };
    const get: NativeFact = {
      ...common,
      id: 6,
      start: 6,
      end: 7,
      method: 'get',
      phase: 'read',
      buffer: 1,
      epoch: 0,
      address: ['x'],
      result: missing,
      base: { found: true, value: stale },
    };
    const back: NativeFact = {
      ...common,
      id: 12,
      start: 12,
      end: 13,
      method: 'set',
      phase: 'write',
      buffer: 1,
      epoch: 0,
      address: ['x'],
      value: edited,
    };
    Object.assign(back, { valueObject: 7 });
    const commit: CommitObservation = {
      ...common,
      id: 21,
      start: 21,
      end: 30,
      method: 'commit',
      phase: 'commit',
      buffer: 1,
      epoch: 0,
      encoder: {
        method: 'toChangeOnlyPayload',
        start: 22,
        end: 25,
        bytes: build ? 'actual-new-producer-bytes' : 'actual-old-producer-bytes',
        mode: 'full',
      },
    };
    const bound: OperationRead = { coordinate, frame: 1, start: 0, end: 20, nativeId: 5 };
    const calls = build ? [del, read] : [del, read, write];
    const events: NativeFact[] = build
      ? [del, mutation, read, get, commit]
      : [del, mutation, read, get, write, back, commit];
    for (const event of events)
      Object.assign(event, { tier: Object.hasOwn(event, 'call') ? 'stage-call' : 'buffer-call' });
    const branch: BranchReceipt = {
      operation: bound,
      programPath: ['stages', 0, 'ops', 0],
      path: [],
      calls,
      edits: [
        {
          outcome: 'returned',
          start: 9,
          end: 10,
          object: build ? undefined : 7,
          n: 9,
          before: build ? missing : stale,
          after: build ? missing : edited,
        },
      ],
    };
    const run: JoinedRun = {
      program,
      native: { leg: 'run', events, issues: [] },
      commits: [{ bytes: commit.encoder.bytes, foldsBack: true, nativeId: 21 }],
      kept: { state: build ? '{}' : '{"x":[3,9]}' },
    };
    return { run, branch, commit };
  };
  const old = one(false);
  const now = one(true);
  const pair: ReadPair = { baseline: old.branch.operation, build: now.branch.operation, sites: [] };
  const cause: Cause = {
    pair,
    baseline: old.branch,
    build: now.branch,
    baselineCommit: old.commit,
    buildCommit: now.commit,
  };
  return { a: old.run, b: now.run, cause };
}
const judge = (f: ReturnType<typeof fixture>) => firstCommit124(f.a, f.b, f.cause);

function withContinuation() {
  const f = fixture();
  const after = array(number(3), number(9), number(4));
  const pointer = ['stages', 0, 'ops', 1] as const;
  const op = ['writeback', 0, 1] as const;
  for (const [isBuild, run, primary, commit] of [
    [false, f.a, f.cause.baseline, f.cause.baselineCommit],
    [true, f.b, f.cause.build, f.cause.buildCommit],
  ] as const) {
    Object.assign(commit, { id: 61, start: 61, end: 70 });
    Object.assign(commit.encoder, { start: 62, end: 65 });
    Object.assign(run.commits[0], { nativeId: 61 });
    const common = { leg: 'run', frame: 1, header: primary.calls[0].header, outcome: 'returned' as const };
    const read: FixtureCall = {
      ...common,
      tier: 'stage-call',
      id: 23,
      start: 23,
      end: 28,
      method: 'getValue',
      phase: 'read',
      operation: op,
      call: { args: [path, string('x')], objects: [] },
      gets: [24],
      result: isBuild ? missing : edited,
      resultObject: isBuild ? undefined : 7,
      resultIdentities: isBuild ? [] : [{ path: [], object: 7 }],
    };
    const get: NativeFact = {
      ...common,
      tier: 'buffer-call',
      id: 24,
      start: 24,
      end: 27,
      method: 'get',
      phase: 'read',
      operation: op,
      buffer: 1,
      epoch: 0,
      address: ['x'],
      result: isBuild ? missing : edited,
    };
    const write: FixtureCall = {
      ...common,
      tier: 'stage-call',
      id: 31,
      start: 31,
      end: 34,
      method: 'setObject',
      phase: 'write',
      operation: op,
      call: {
        args: [path, string('x'), after],
        objects: [undefined, undefined, 7],
        identities: [[], [], [{ path: [], object: 7 }]],
      },
    };
    const physical: NativeFact = {
      ...common,
      tier: 'buffer-call',
      id: 32,
      start: 32,
      end: 33,
      method: 'set',
      phase: 'write',
      operation: op,
      buffer: 1,
      epoch: 0,
      address: ['x'],
      value: after,
      valueObject: 7,
    };
    const span = {
      coordinate: op,
      programPath: pointer,
      path: [] as string[],
      start: 22,
      end: isBuild ? 40 : 50,
      outcome: 'returned' as const,
      edits: [
        {
          outcome: 'returned' as const,
          start: 29,
          end: 30,
          object: isBuild ? undefined : 7,
          n: 4,
          before: isBuild ? missing : edited,
          after: isBuild ? missing : after,
        },
      ],
    };
    Object.assign(run, {
      program: JSON.stringify({
        commitValues: 'full',
        stages: [
          {
            ops: [
              { t: 'delReadBack', path: 0, k: 'x', n: 9, how: 'set' },
              { t: 'readBack', path: 0, k: 'x', n: 4, how: 'set' },
            ],
          },
        ],
      }),
      operations: [span],
      native: {
        ...run.native,
        events: [
          ...run.native.events.filter((row) => row !== commit),
          read,
          get,
          ...(isBuild ? [] : [write, physical]),
          commit,
        ],
      },
    });
  }
  return f;
}

/** Static inert extension of the EXISTING fixture; this does not execute or emulate native merge. */
function withMergeProducedContinuation() {
  const f = withContinuation();
  const oldReadValue: ValueFact = { kind: 'object', entries: [['n', true, number(0)]] };
  const mergedValue: ValueFact = { kind: 'object', entries: [['n', true, number(9)]] };
  const p = JSON.parse(f.a.program);
  p.stages[0].ops[0].how = 'merge';
  p.stages[0].ops[1].n = 9;
  for (const [isBuild, run, branch, commit] of [
    [false, f.a, f.cause.baseline, f.cause.baselineCommit],
    [true, f.b, f.cause.build, f.cause.buildCommit],
  ] as const) {
    Object.assign(run, { program: JSON.stringify(p) });
    const get = run.native.events.find((row) => row.id === 6)!;
    Object.assign(get, { base: { found: true, value: oldReadValue } });
    if (!isBuild) {
      Object.assign(branch.calls[1], { result: oldReadValue, resultIdentities: [{ path: [], object: 7 }] });
      Object.assign(branch.calls[2], { method: 'updateObject' });
      Object.assign(branch.calls[2].call, { args: [path, string('x'), mergedValue] });
      Object.assign(branch.edits[0], { before: oldReadValue, after: mergedValue });
      Object.assign(run.native.events.find((row) => row.id === 12)!, { method: 'merge', value: mergedValue });
    }
    const read = run.native.events.find((row) => row.id === 23)!;
    const laterGet = run.native.events.find((row) => row.id === 24)!;
    if (!isBuild) {
      Object.assign(read, { result: mergedValue, resultObject: 8, resultIdentities: [{ path: [], object: 8 }] });
      Object.assign(laterGet, { result: mergedValue });
      Object.assign(run.native.events.find((row) => row.id === 31)!.call!, {
        args: [path, string('x'), mergedValue],
        objects: [undefined, undefined, 8],
        identities: [[], [], [{ path: [], object: 8 }]],
      });
      Object.assign(run.native.events.find((row) => row.id === 32)!, { value: mergedValue, valueObject: 8 });
    }
    Object.assign(run.operations![0].edits[0], {
      n: 9,
      object: isBuild ? undefined : 8,
      before: isBuild ? missing : mergedValue,
      after: isBuild ? missing : mergedValue,
    });
    const bytes = JSON.stringify({ overwrite: { x: isBuild ? '«undefined»' : { n: 9 } }, updates: {}, trace: [] });
    Object.assign(commit.encoder, { bytes });
    Object.assign(run.commits[0], { bytes });
  }
  return f;
}
describe('same FIRST cause, WRITEBACK native-produced root bridge', () => {
  it('names actual returned root 8 and its write instead of calling merge INPUT 7 the SAME object', () => {
    const f = withMergeProducedContinuation();
    const before = JSON.stringify(f);
    expect(judge(f)).toMatchObject({
      kind: 'cause',
      coordinate,
      propagation: [
        {
          operation: ['writeback', 0, 1],
          baselineIdentity: 8,
          baselineProducer: 12,
          fromAddress: ['x'],
          toAddress: ['x'],
          buildValue: missing,
          via: 'native-producer-readback',
        },
      ],
    });
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each([
    'set-not-merge',
    'write-clone',
    'read-root-missing',
    'wrong-record',
    'later-changed-value',
    'intervening-producer',
    'foreign-row',
    'encoder',
    'fold-back',
  ])('refuses %s without a temporal or content-only bridge', (damage) => {
    const f = withMergeProducedContinuation();
    const read = f.a.native.events.find((row) => row.id === 23)!;
    const write = f.a.native.events.find((row) => row.id === 31)!;
    const physical = f.a.native.events.find((row) => row.id === 32)!;
    if (damage === 'set-not-merge') {
      const p = JSON.parse(f.a.program);
      p.stages[0].ops[0].how = 'set';
      Object.assign(f.a, { program: JSON.stringify(p) });
      Object.assign(f.b, { program: JSON.stringify(p) });
      Object.assign(f.cause.baseline.calls[2], { method: 'setObject' });
      Object.assign(f.a.native.events.find((row) => row.id === 12)!, { method: 'set' });
    }
    if (damage === 'write-clone') Object.assign(write.call!, { objects: [undefined, undefined, 99] });
    if (damage === 'read-root-missing') Object.assign(read, { resultIdentities: [] });
    if (damage === 'wrong-record') {
      const bytes = JSON.stringify({ overwrite: { x: { n: 99 } }, updates: {}, trace: [] });
      Object.assign(f.cause.baselineCommit.encoder, { bytes });
      Object.assign(f.a.commits[0], { bytes });
    }
    if (damage === 'later-changed-value') {
      const next = { kind: 'object', entries: [['n', true, number(10)]] };
      const p = JSON.parse(f.a.program);
      p.stages[0].ops[1].n = 10;
      Object.assign(f.a, { program: JSON.stringify(p) });
      Object.assign(f.b, { program: JSON.stringify(p) });
      Object.assign(f.a.operations![0].edits[0], { n: 10, after: next });
      Object.assign(f.b.operations![0].edits[0], { n: 10 });
      Object.assign(write.call!, { args: [path, string('x'), next] });
      Object.assign(physical, { value: next });
      const bytes = JSON.stringify({ overwrite: { x: { n: 10 } }, updates: {}, trace: [] });
      Object.assign(f.cause.baselineCommit.encoder, { bytes });
      Object.assign(f.a.commits[0], { bytes });
    }
    if (damage === 'intervening-producer') {
      const old = f.a.native.events.find((row) => row.id === 12)!;
      (f.a.native.events as NativeFact[]).push({ ...old, id: 18, start: 18, end: 19 });
    }
    if (damage === 'foreign-row') {
      const old = f.a.native.events.find((row) => row.id === 12)!;
      (f.a.native.events as NativeFact[]).push({ ...old, id: 51, start: 51, end: 52, address: ['other'] });
    }
    if (damage === 'encoder') Object.assign(f.cause.baselineCommit.encoder, { bytes: '{}' });
    if (damage === 'fold-back') Object.assign(f.b.commits[0], { foldsBack: false });
    expect(judge(f).kind).toBe('unproven');
  });
});
