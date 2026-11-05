import { describe, expect, it } from 'vitest';

import type { JoinedRun, OperationRead, ReadPair } from '../readLawWitness.js';
import type { NativeFact, ValueFact } from '../readWitness.js';
import { firstCommit124 } from './index.js';
import type { BranchReceipt, Cause, CommitObservation, FixtureCall } from './types.js';

const U = Symbol('undefined fixture data');
const fact = (value: any): ValueFact =>
  value === U
    ? { kind: 'undefined' }
    : value === null
    ? { kind: 'null' }
    : typeof value !== 'object'
    ? { kind: typeof value, value: typeof value === 'number' ? String(value) : value }
    : {
        kind: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? { value: value.length } : {}),
        entries: Object.entries(value).map(([key, child]) => [key, true, fact(child)]),
      };
type Write = { key?: string; value: any; id?: number; method?: 'setObject' | 'updateObject' };
/** Scripted immutable observation data; these tests do not execute or replace an engine. */
function fixture(
  op: Record<string, unknown>,
  oldValue: any,
  oldWrites: Write[],
  nowWrites: Write[],
  prefix: string[] = [],
) {
  const coordinate = ['chart', 0, 'stage', 0, 'invocation', 0, 'op', 1];
  const program = JSON.stringify({ cfg: { commitValues: 'full' }, stages: [[{ t: 'del', k: 'a' }, op]] });
  const side = (build: boolean) => {
    const header = { stageId: 's', runId: build ? 'current' : 'old', runtimeStageId: 's#1' };
    const common = { leg: 'run', frame: 1, header, outcome: 'returned' as const };
    const read: FixtureCall = {
      ...common,
      id: 5,
      start: 5,
      end: 8,
      method: 'getValue',
      phase: 'read',
      tier: 'stage-call',
      operation: coordinate,
      result: fact(build ? U : oldValue),
      resultObject: !build && oldValue !== null && typeof oldValue === 'object' ? 7 : undefined,
      resultIdentities: !build && oldValue !== null && typeof oldValue === 'object' ? [{ path: [], object: 7 }] : [],
      gets: [6],
      call: { args: [fact([]), fact('a')], objects: [49, undefined] },
    };
    const deleted: NativeFact = {
      ...common,
      id: 2,
      start: 2,
      end: 3,
      method: 'delete',
      phase: 'write',
      tier: 'buffer-call',
      buffer: 1,
      epoch: 0,
      address: [...prefix, 'a'],
    };
    const get: NativeFact = {
      ...common,
      id: 6,
      start: 6,
      end: 7,
      method: 'get',
      phase: 'read',
      operation: coordinate,
      tier: 'buffer-call',
      buffer: 1,
      epoch: 0,
      address: [...prefix, 'a'],
      result: fact(U),
      base: { found: true, value: fact(oldValue) },
    };
    const writes = build ? nowWrites : oldWrites;
    const calls: FixtureCall[] = [read];
    const events: NativeFact[] = [deleted, read, get];
    writes.forEach((write, i) => {
      const start = 11 + i * 4;
      const name = write.key ?? 'a';
      const method = write.method ?? 'setObject';
      const tail = method === 'setObject' ? [fact(U), fact(U)] : [fact(U)];
      const call: FixtureCall = {
        ...common,
        id: start,
        start,
        end: start + 3,
        method,
        phase: 'write',
        tier: 'stage-call',
        operation: coordinate,
        call: {
          args: [fact([]), fact(name), fact(write.value), ...tail],
          objects: [50 + i, undefined, write.id, ...tail.map(() => undefined)],
          identities: [
            [{ path: [], object: 50 + i }],
            [],
            write.id === undefined ? [] : [{ path: [], object: write.id }],
            ...tail.map(() => []),
          ],
        },
      };
      const native: NativeFact = {
        ...common,
        id: start + 1,
        start: start + 1,
        end: start + 2,
        method: method === 'setObject' ? 'set' : 'merge',
        phase: 'write',
        operation: coordinate,
        tier: 'buffer-call',
        buffer: 1,
        epoch: 0,
        address: [...prefix, name],
        value: fact(write.value),
        valueObject: write.id,
      };
      calls.push(call);
      events.push(call, native);
    });
    const commit: CommitObservation = {
      ...common,
      id: 30,
      start: 30,
      end: 40,
      method: 'commit',
      phase: 'commit',
      tier: 'buffer-call',
      buffer: 1,
      epoch: 0,
      encoder: {
        method: 'toChangeOnlyPayload',
        mode: 'full',
        start: 31,
        end: 33,
        bytes: build ? 'new-producer' : 'old-producer',
      },
    };
    events.push(commit);
    const operation: OperationRead = { coordinate, frame: 1, start: 4, end: 25, nativeId: read.id };
    const branch: BranchReceipt = { operation, programPath: ['stages', 0, 1], path: [], calls, edits: [] };
    const run: JoinedRun = {
      program,
      native: { leg: 'run', events, issues: [] },
      kept: {},
      commits: [{ bytes: commit.encoder.bytes, foldsBack: true, nativeId: 30 }],
    };
    return { run, branch, read, commit };
  };
  const a = side(false);
  const b = side(true);
  const pair: ReadPair = { baseline: a.branch.operation, build: b.branch.operation, sites: [] };
  const cause: Cause = { pair, baseline: a.branch, build: b.branch, baselineCommit: a.commit, buildCommit: b.commit };
  return { a: a.run, b: b.run, cause };
}
const judge = (f: ReturnType<typeof fixture>) => firstCommit124(f.a, f.b, f.cause, 'chart');

describe('shared FIRST/native guard around closed CHART strategies', () => {
  it.each([
    [{ t: 'same', k: 'a' }, { x: 1 }, [{ value: { x: 1 }, id: 7 }], [{ value: U }]],
    [{ t: 'copy', k: 'a', k2: 'b' }, { x: 1 }, [{ key: 'b', value: { x: 1 }, id: 7 }], [{ key: 'b', value: U }]],
    [{ t: 'same', k: 'a' }, 3, [{ value: 3 }], [{ value: U }]],
    [{ t: 'spread', k: 'a', p: 'y', v: 3 }, { x: 1 }, [{ value: { x: 1, y: 3 }, id: 8 }], []],
    [{ t: 'batch', k: 'a', v: 2 }, [1], [{ value: [1, 2], id: 8 }], [{ value: [2], id: 7 }]],
    [{ t: 'revert', k: 'a', v: 4 }, { x: 1 }, [{ value: 4 }, { value: { x: 1 }, id: 7 }], [{ value: 4 }, { value: U }]],
  ] as const)('names only a fully guarded %j first cause', (op, value, old, now) => {
    const result = judge(fixture(op as any, value, old as any, now as any));
    expect(result, JSON.stringify(result)).toMatchObject({
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: 0,
    });
  });
  it('copy uses the real canonical prefix and different destination, not a namespace-name rule', () => {
    const f = fixture(
      { t: 'copy', k: 'a', k2: 'b' },
      { x: 1 },
      [{ key: 'b', value: { x: 1 }, id: 7 }],
      [{ key: 'b', value: U }],
      ['arbitrary-observed-prefix', 'owner'],
    );
    expect(judge(f).kind).toBe('cause');
    const write = f.b.native.events.find((event) => event.tier === 'buffer-call' && event.method === 'set')!;
    (write as any).address = ['other', 'owner', 'b'];
    expect(judge(f).kind).toBe('unproven');
  });
  it.each(['fold', 'encoder', 'same-object', 'extra-native-write', 'cloned-call', 'wrong-mode', 'fallback'])(
    'a valid declared same branch cannot bypass %s common evidence',
    (damage) => {
      const f = fixture({ t: 'same', k: 'a' }, { x: 1 }, [{ value: { x: 1 }, id: 7 }], [{ value: U }]);
      if (damage === 'fold') (f.b.commits[0] as any).foldsBack = false;
      if (damage === 'encoder') (f.b.commits[0] as any).bytes = 'unrelated-duplicate-row';
      if (damage === 'same-object') (f.cause.baseline.calls[1].call.objects as any)[2] = 8;
      if (damage === 'extra-native-write') {
        const source = f.a.native.events.find((event) => event.method === 'set')!;
        (f.a.native.events as NativeFact[]).push({ ...source, id: 99, start: 18, end: 19 });
      }
      if (damage === 'cloned-call') (f.cause.baseline.calls as FixtureCall[])[1] = { ...f.cause.baseline.calls[1] };
      if (damage === 'wrong-mode') (f.cause.buildCommit.encoder as any).mode = 'delta';
      if (damage === 'fallback') (f.b.native.events.find((event) => event.method === 'get') as any).base.found = false;
      expect(judge(f).kind).toBe('unproven');
    },
  );
  it('does not clear an unrelated native read before the proved operation', () => {
    const f = fixture({ t: 'same', k: 'a' }, { x: 1 }, [{ value: { x: 1 }, id: 7 }], [{ value: U }]);
    const primary = f.cause.baseline.calls[0];
    const prefix = {
      ...primary,
      id: 1,
      start: 1,
      end: 1.5,
      operation: undefined,
      gets: [],
      resultObject: undefined,
      result: fact(1),
    };
    (f.a.native.events as NativeFact[]).unshift(prefix);
    (f.b.native.events as NativeFact[]).unshift({ ...prefix, result: fact(2) });
    expect(judge(f).kind).toBe('unproven');
  });
  it('literal-only fallback writes that are identical cannot explain a changed coherent commit', () => {
    const f = fixture(
      { t: 'setIn', k: 'a', p: 'x', v: 2 },
      3,
      [{ value: { x: 2 }, id: 8 }],
      [{ value: { x: 2 }, id: 7 }],
    );
    expect(judge(f).kind).toBe('unproven');
  });
  it('nested/proxy payloads remain unproved rather than receiving an opcode grant', () => {
    const f = fixture({ t: 'push', k: 'a', v: 2 }, [{ x: 1 }], [], [{ value: [2], id: 7 }]);
    expect(judge(f).kind).toBe('unproven');
  });
});
