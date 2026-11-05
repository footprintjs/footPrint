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
    expect(judge(fixture())).toEqual({
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: 0,
      coordinate,
      nativeTrace: {
        windows: [{ coordinate, baseline: { start: 0, end: 20 }, build: { start: 0, end: 20 } }],
        crossEngineFields: 'semantic',
        actorIdentity: 'record-level (r13 view)',
        encoder: { crossEngine: 'bytes', ownEngine: 'method↔mode↔outer' },
        recordViews: ['r13', 'c-f5-seed-policy-order'],
      },
    });
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

/** Pure receipt arrangement for the comparison DOMAIN, not proof of a real mapper/engine. */
function withActorMovedPrefix() {
  const f = fixture();
  const prefix: { stage: NativeFact; write: NativeFact; commit: NativeFact; read: NativeFact }[] = [];
  for (const [side, run, branch] of [
    ['baseline', f.a, f.cause.baseline],
    ['build', f.b, f.cause.build],
  ] as const) {
    // Shift the existing inert clock as one unit, keeping every original local join/order intact.
    // This does not alter a program, opcode, value, declared edit or generated corpus.
    for (const event of run.native.events) {
      Object.assign(event, { id: event.id + 20, start: event.start + 20, end: event.end + 20 });
      if (event.gets) Object.assign(event, { gets: event.gets.map((id) => id + 20) });
      if (event.encoder) Object.assign(event.encoder, { start: event.encoder.start + 20, end: event.encoder.end + 20 });
    }
    Object.assign(branch.operation, {
      start: branch.operation.start + 20,
      end: branch.operation.end + 20,
      nativeId: branch.operation.nativeId + 20,
    });
    for (const edit of branch.edits) Object.assign(edit, { start: edit.start + 20, end: edit.end + 20 });
    for (const row of run.commits) Object.assign(row, { nativeId: row.nativeId! + 20 });
    const owner = {
      leg: 'run',
      frame: side === 'baseline' ? 2 : 9,
      header: {
        stageId: side === 'baseline' ? 'old-mapper-actor' : 'new-mapper-actor',
        runtimeStageId: side === 'baseline' ? 'old-placement' : 'new-placement',
        runId: side,
      },
      outcome: 'returned' as const,
    };
    const stage: NativeFact = {
      ...owner,
      id: 1,
      start: 1,
      end: 4,
      tier: 'stage-call',
      method: 'setGlobal',
      phase: 'write',
      call: { args: [string('prefix'), number(7)], objects: [] },
    };
    const write: NativeFact = {
      ...owner,
      id: 2,
      start: 2,
      end: 3,
      tier: 'buffer-call',
      method: 'set',
      phase: 'write',
      buffer: side === 'baseline' ? 2 : 8,
      epoch: 0,
      address: ['prefix'],
      value: number(7),
    };
    const commit: NativeFact = {
      ...owner,
      id: 5,
      start: 5,
      end: 9,
      tier: 'buffer-call',
      method: 'commit',
      phase: 'commit',
      buffer: side === 'baseline' ? 2 : 8,
      epoch: 0,
      encoder: { method: 'toChangeOnlyPayload', start: 6, end: 8, mode: 'full', bytes: 'same-prefix-producer' },
    };
    const read: NativeFact = {
      ...owner,
      id: 10,
      start: 10,
      end: 12,
      tier: 'stage-call',
      method: 'getValueDirect',
      phase: 'read',
      call: { args: [path, string('prefix')], objects: [100, undefined] },
      gets: [],
      result: number(7),
    };
    (run.native.events as NativeFact[]).unshift(stage, write, commit, read);
    Object.assign(run, { commits: [{ bytes: 'same-prefix-producer', foldsBack: true, nativeId: 5 }, ...run.commits] });
    prefix.push({ stage, write, commit, read });
  }
  return { ...f, oldPrefix: prefix[0], newPrefix: prefix[1] };
}

describe('FIRST boundary native domain: strict operation, semantic prefix, record-owned actors', () => {
  it('does not reject an otherwise exact native prefix solely for moved actor/header/frame placement', () => {
    const f = withActorMovedPrefix();
    expect(judge(f)).toEqual({
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: 1,
      coordinate,
      nativeTrace: {
        windows: [{ coordinate, baseline: { start: 20, end: 40 }, build: { start: 20, end: 40 } }],
        crossEngineFields: 'semantic',
        actorIdentity: 'record-level (r13 view)',
        encoder: { crossEngine: 'bytes', ownEngine: 'method↔mode↔outer' },
        recordViews: ['r13', 'c-f5-seed-policy-order'],
      },
    });
    // This component does not run the R13 record view. The final caller must still judge placement there.
  });

  it.each(['method', 'arguments', 'result', 'outcome', 'address', 'value', 'order', 'encoder-bytes'])(
    'still rejects independent prefix %s changes beside the valid operation',
    (damage) => {
      const f = withActorMovedPrefix();
      if (damage === 'method') Object.assign(f.newPrefix.stage, { method: 'mergeObject' });
      if (damage === 'arguments')
        Object.assign(f.newPrefix.stage, { call: { args: [string('prefix'), number(8)], objects: [] } });
      if (damage === 'result') Object.assign(f.newPrefix.read, { result: number(8) });
      if (damage === 'outcome') Object.assign(f.newPrefix.stage, { outcome: 'threw' });
      if (damage === 'address') Object.assign(f.newPrefix.write, { address: ['other-prefix'] });
      if (damage === 'value') Object.assign(f.newPrefix.write, { value: number(8) });
      if (damage === 'order') {
        const events = f.b.native.events as NativeFact[];
        events.splice(0, 4, f.newPrefix.read, f.newPrefix.stage, f.newPrefix.write, f.newPrefix.commit);
      }
      if (damage === 'encoder-bytes')
        Object.assign(f.newPrefix.commit.encoder!, { bytes: 'independent-corrupt-producer' });
      expect(judge(f).kind).toBe('unproven');
    },
  );

  it.each(['call-frame', 'producer-frame', 'producer-epoch', 'first-encoder', 'build-law'])(
    'keeps the local %s proof unconditional even when prefix actor movement is allowed',
    (damage) => {
      const f = withActorMovedPrefix();
      if (damage === 'call-frame') Object.assign(f.cause.baseline.calls[2], { frame: 99 });
      if (damage === 'producer-frame')
        Object.assign(f.a.native.events.find((event) => event.id === 32)!, { frame: 99 });
      if (damage === 'producer-epoch') Object.assign(f.a.native.events.find((event) => event.id === 32)!, { epoch: 1 });
      if (damage === 'first-encoder') Object.assign(f.cause.buildCommit.encoder, { bytes: 'different-inner-encoder' });
      if (damage === 'build-law') Object.assign(f.b.commits[1], { foldsBack: false });
      expect(judge(f).kind).toBe('unproven');
    },
  );
});

// Append to existing firstCommit124/cause.test.ts. Uses its original fixture(), judge and
// value constructors. Test-only red patch is independently deliverable before any helper edit.
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

describe('FIRST cause same-stage SAME-object readBack continuation — inert records', () => {
  it('keeps the primary cause and records only the identity-proved later branch as explicit data', () => {
    const result = judge(withContinuation());
    expect(result).toMatchObject({
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: 0,
      coordinate,
      continuation: [
        {
          operation: ['writeback', 0, 1],
          address: ['x'],
          baselineObjectId: 7,
          buildRead: { kind: 'undefined' },
          write: false,
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(result)).continuation[0]).toEqual({
      operation: ['writeback', 0, 1],
      address: ['x'],
      baselineObjectId: 7,
      buildRead: { kind: 'undefined' },
      write: false,
    });
  });
  it.each([
    'identity',
    'identity-graph',
    'duplicate-read-root',
    'duplicate-write-root',
    'address',
    'order',
    'missing-edit',
    'missing-get',
    'missing-read',
    'get-result',
    'new-write',
    'physical-value',
    'physical-id',
    'epoch',
    'missing-span',
    'duplicate-span',
    'unknown-op',
  ])('refuses %s instead of excluding any unproved continuation rows', (damage) => {
    const f = withContinuation();
    const read = f.a.native.events.find((row) => row.id === 23)!;
    const physical = f.a.native.events.find((row) => row.id === 32)!;
    const oldSpan = f.a.operations![0];
    if (damage === 'identity') Object.assign(read, { resultObject: 99 });
    if (damage === 'identity-graph') Object.assign(read, { resultIdentities: [{ path: [], object: 99 }] });
    if (damage === 'duplicate-read-root')
      Object.assign(read, {
        resultIdentities: [
          { path: [], object: 7 },
          { path: [], object: 99 },
        ],
      });
    if (damage === 'duplicate-write-root')
      Object.assign(f.a.native.events.find((row) => row.id === 31)!.call!, {
        identities: [
          [],
          [],
          [
            { path: [], object: 7 },
            { path: [], object: 99 },
          ],
        ],
      });
    if (damage === 'address') Object.assign(physical, { address: ['unrelated'] });
    if (damage === 'order') Object.assign(read, { start: 21 });
    if (damage === 'missing-edit') Object.assign(oldSpan, { edits: [] });
    if (damage === 'missing-get') Object.assign(read, { gets: [] });
    if (damage === 'missing-read')
      Object.assign(f.b, { native: { ...f.b.native, events: f.b.native.events.filter((row) => row.id !== 23) } });
    if (damage === 'get-result') Object.assign(f.a.native.events.find((row) => row.id === 24)!, { result: missing });
    if (damage === 'new-write') {
      const foreign = { ...f.a.native.events.find((row) => row.id === 31)!, header: f.cause.build.calls[0].header };
      Object.assign(f.b, {
        native: {
          ...f.b.native,
          events: [...f.b.native.events.filter((row) => row.id !== 61), foreign, f.cause.buildCommit],
        },
      });
    }
    if (damage === 'physical-value') Object.assign(physical, { value: array(number(99)) });
    if (damage === 'physical-id') Object.assign(physical, { valueObject: 99 });
    if (damage === 'epoch') Object.assign(physical, { epoch: 1 });
    if (damage === 'missing-span') Object.assign(f.b, { operations: undefined });
    if (damage === 'duplicate-span') Object.assign(f.a, { operations: [oldSpan, oldSpan] });
    if (damage === 'unknown-op') {
      const p = JSON.parse(f.a.program);
      p.stages[0].ops[1].t = 'delReadBack';
      Object.assign(f.a, { program: JSON.stringify(p) });
      Object.assign(f.b, { program: JSON.stringify(p) });
    }
    expect(judge(f).kind).toBe('unproven');
  });
  it('does not mask unrelated read corruption after the proved continuation but before FIRST commit', () => {
    const f = withContinuation();
    for (const [isBuild, run, primary, commit] of [
      [false, f.a, f.cause.baseline, f.cause.baselineCommit],
      [true, f.b, f.cause.build, f.cause.buildCommit],
    ] as const) {
      const row: NativeFact = {
        tier: 'stage-call',
        id: 51,
        start: 51,
        end: 54,
        leg: 'run',
        frame: 1,
        header: primary.calls[0].header,
        method: 'getValue',
        phase: 'read',
        outcome: 'returned',
        call: { args: [path, string('other')], objects: [] },
        result: number(isBuild ? 2 : 1),
      };
      Object.assign(run, {
        native: { ...run.native, events: [...run.native.events.filter((entry) => entry !== commit), row, commit] },
      });
    }
    expect(judge(f).kind).toBe('unproven');
  });
  it('keeps unconditional BUILD fold-back and actual FIRST encoder checks with a valid continuation', () => {
    const fold = withContinuation();
    Object.assign(fold.b.commits[0], { foldsBack: false });
    expect(judge(fold).kind).toBe('unproven');
    const encoder = withContinuation();
    Object.assign(encoder.cause.buildCommit.encoder, { bytes: 'not-the-saved-actual-encoder' });
    expect(judge(encoder).kind).toBe('unproven');
  });
});
