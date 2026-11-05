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

describe('FIRST changed commit #124 cause — inert actual-call records only', () => {
  it('names the exact closed old-object/edit/write versus new-undefined/no-write branch', () => {
    expect(judge(fixture())).toEqual({ kind: 'cause', name: 'read-after-delete-124', commit: 0, coordinate });
  });
  it('does not accept a coherent unrelated commit rewrite beside the valid read', () => {
    const f = fixture();
    f.b = { ...f.b, commits: [{ ...f.b.commits[0], bytes: 'duplicate-trace-row', foldsBack: true }] };
    expect(judge(f)).toMatchObject({ kind: 'unproven' });
  });
  it('does not allow this cause to bypass BUILD fold-back or steal the old admission cause', () => {
    const bad = fixture();
    bad.b = { ...bad.b, commits: [{ ...bad.b.commits[0], foldsBack: false }] };
    expect(judge(bad).kind).toBe('unproven');
    const old = fixture();
    old.a = { ...old.a, commits: [{ ...old.a.commits[0], foldsBack: false }] };
    expect(judge(old).kind).toBe('unproven');
  });
  it.each(['stale', 'wrong-object', 'wrong-edit', 'extra-call', 'new-write', 'mode', 'other-epoch', 'missing-encoder'])(
    'refuses %s instead of granting downstream permission',
    (damage) => {
      const f = fixture();
      if (damage === 'stale') Object.assign(f.b.native.events.find((e) => e.id === 5)!, { result: stale });
      if (damage === 'wrong-object') (f.cause.baseline.calls[2].call.objects as any)[2] = 99;
      if (damage === 'wrong-edit') (f.cause.baseline.edits[0] as any).after = array(number(42));
      if (damage === 'extra-call') (f.cause.baseline.calls as FixtureCall[]).push(f.cause.baseline.calls[0]);
      if (damage === 'new-write') (f.cause.build.calls as FixtureCall[]).push(f.cause.baseline.calls[2]);
      if (damage === 'mode') (f.cause.buildCommit.encoder as any).mode = 'delta';
      if (damage === 'other-epoch') (f.cause.buildCommit as any).epoch = 1;
      if (damage === 'missing-encoder') (f.cause.buildCommit as any).encoder = undefined;
      expect(judge(f).kind).toBe('unproven');
    },
  );
  it('refuses an internally consistent wrong edit/write beside the valid native deleted read', () => {
    const f = fixture();
    const wrong = array(number(42));
    Object.assign(f.cause.baseline.edits[0], { after: wrong });
    (f.cause.baseline.calls[2].call.args as ValueFact[])[2] = wrong;
    Object.assign(f.a.native.events.find((event) => event.id === 12)!, { value: wrong });
    expect(judge(f).kind).toBe('unproven');
  });
  it('refuses a later claimed cause after an earlier unexplained commit divergence', () => {
    const f = fixture();
    f.a = { ...f.a, commits: [{ bytes: 'prefix-a', foldsBack: true }, ...f.a.commits] };
    f.b = { ...f.b, commits: [{ bytes: 'prefix-b', foldsBack: true }, ...f.b.commits] };
    expect(judge(f).kind).toBe('unproven');
  });
});
