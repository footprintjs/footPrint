/** Rule-based inert controls. Original data/identities are scripted; no engine executes here. */
import { describe, expect, it } from 'vitest';

import { chartBranchPair } from '../chartBranch.js';
import { fact, side, UNDEF } from '../chartBranchFixture.js';

type Kind = 'push' | 'elem' | 'setIn' | 'batch';
type Graph = { path: string[]; object: number }[];
const methods = {
  push: ['getValue', 'getValue', 'getValueDirect', 'getValueDirect'],
  elem: ['getValue', 'getValue', 'getValueDirect', 'getValueDirect', 'getValueDirect'],
  setIn: ['getValue', 'getValue'],
  batch: ['getValue'],
};
function readGraph(bound: any, graph: Graph) {
  for (const call of bound.branch.calls.filter((row: any) => row.phase === 'read')) call.resultIdentities = graph;
}
function argumentGraph(bound: any, graph: Graph) {
  const call = bound.branch.calls.find((row: any) => row.phase === 'write');
  call.call.identities[2] = graph;
}
function fixture(kind: Kind) {
  const value =
    kind === 'push'
      ? [8]
      : kind === 'setIn'
      ? { x: 0, deep: { q: 1 } }
      : kind === 'elem'
      ? [{ x: 0, deep: { q: 1 } }]
      : [[]];
  const output =
    kind === 'push'
      ? [8, null]
      : kind === 'setIn'
      ? { y: 1 }
      : kind === 'elem'
      ? [{ x: 1, deep: { q: 1 } }]
      : [[], null];
  const old = side(value, [{ value: output, id: 2, merge: kind === 'setIn' }], 11, 1, methods[kind]);
  const now = side(UNDEF, kind === 'elem' ? [] : [{ value: kind === 'setIn' ? { y: 1 } : [null], id: 2 }]);
  const op: any = {
    t: kind,
    k: 'a',
    ...(kind === 'elem' ? { i: 0, p: 'x', v: 1 } : kind === 'setIn' ? { p: 'y', v: 1 } : { v: null }),
  };
  if (kind === 'setIn')
    readGraph(old, [
      { path: [], object: 1 },
      { path: ['deep'], object: 8 },
    ]);
  if (kind === 'elem') {
    readGraph(old, [
      { path: [], object: 1 },
      { path: ['0'], object: 8 },
      { path: ['0', 'deep'], object: 9 },
    ]);
    argumentGraph(old, [
      { path: [], object: 2 },
      { path: ['0'], object: 3 },
      { path: ['0', 'deep'], object: 9 },
    ]);
  }
  if (kind === 'batch') {
    readGraph(old, [
      { path: [], object: 1 },
      { path: ['0'], object: 8 },
    ]);
    argumentGraph(old, [
      { path: [], object: 2 },
      { path: ['0'], object: 3 },
    ]);
  }
  return { kind, op, old, now };
}
const judge = (f: ReturnType<typeof fixture>) => chartBranchPair(f.op, f.old, f.now);
const writeOf = (bound: any) => bound.branch.calls.find((row: any) => row.phase === 'write');
function nativeWrite(bound: any) {
  const call = writeOf(bound);
  return bound.native.events.find(
    (row: any) => row.tier === 'buffer-call' && row.phase === 'write' && call.start < row.start && row.end < call.end,
  );
}
function replaceWriteValue(bound: any, value: unknown) {
  writeOf(bound).call.args[2] = fact(value);
  nativeWrite(bound).value = writeOf(bound).call.args[2];
}

describe.each(['push', 'elem', 'setIn', 'batch'] as const)('one closed declared projection row: %s', (kind) => {
  it('proves only its own declared read-to-write branch and preserves original facts', () => {
    const f = fixture(kind);
    const before = JSON.stringify(f);
    expect(judge(f).kind).toBe('declared-chart-branches');
    expect(judge(f).kind).not.toBe('cause');
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each([
    'projection',
    'literal',
    'foreign-read',
    'read-graph',
    'argument-graph',
    'get-address',
    'fallback-path-id',
    'heap-generation',
    'extra-producer',
    'missing-native',
    'clone-call',
    'wrong-method-role',
  ])('refuses %s even with the right opcode and method roles', (damage) => {
    const f = fixture(kind);
    if (damage === 'projection') replaceWriteValue(f.old, kind === 'setIn' ? { y: 99 } : [99]);
    if (damage === 'literal') f.op.v = 'different';
    const read = f.old.branch.calls.filter((row: any) => row.phase === 'read').at(-1);
    if (damage === 'wrong-method-role') read.method = read.method === 'getValue' ? 'getValueDirect' : 'getValue';
    if (damage === 'foreign-read') {
      if (kind === 'batch') f.old.read = { ...f.old.read };
      else {
        read.resultObject = 99;
        read.resultIdentities = [{ path: [], object: 99 }];
        f.old.native.events.find((row: any) => row.parentRead === read.id).resultObject = 99;
      }
    }
    if (damage === 'read-graph') read.resultIdentities = undefined;
    if (damage === 'argument-graph') writeOf(f.old).call.identities[2] = undefined;
    if (damage === 'get-address') f.old.native.events.find((row: any) => row.id === read.gets[0]).address = ['other'];
    if (damage === 'fallback-path-id')
      f.old.native.events.find((row: any) => row.parentRead === read.id).call.objects[1] = 999;
    if (damage === 'heap-generation') read.heapAfter = { ...read.heapAfter, generation: 999 };
    if (damage === 'extra-producer') {
      const producer = nativeWrite(f.old);
      f.old.native.events.push({ ...producer, id: 9999, start: producer.end + 0.1, end: producer.end + 0.2 });
    }
    if (damage === 'missing-native') f.old.native = undefined;
    if (damage === 'clone-call') f.old.branch.calls[1] = { ...f.old.branch.calls[1] };
    expect(judge(f).kind).toBe('unproven');
  });
});

describe('identity laws stay distinct inside the one table', () => {
  it('refuses an independent native producer after the declared call but inside its operation', () => {
    const f = fixture('batch');
    const call = writeOf(f.old);
    const producer = nativeWrite(f.old);
    f.old.native.events.push({ ...producer, id: 9999, start: call.end + 0.1, end: call.end + 0.2 });
    expect(judge(f).kind).toBe('unproven');
  });
  it('refuses the old SAME copied-child batch assumption rather than weakening spread identity', () => {
    const f = fixture('batch');
    argumentGraph(f.old, [
      { path: [], object: 2 },
      { path: ['0'], object: 8 },
    ]);
    expect(judge(f).kind).toBe('unproven');
  });
  it('refuses an element surviving deep subtree replaced by an equal-content clone', () => {
    const f = fixture('elem');
    argumentGraph(f.old, [
      { path: [], object: 2 },
      { path: ['0'], object: 3 },
      { path: ['0', 'deep'], object: 99 },
    ]);
    expect(judge(f).kind).toBe('unproven');
  });
  it.each(['outer', 'element'])('refuses changed %s identity aliased with the read', (part) => {
    const f = fixture('elem');
    const call = writeOf(f.old);
    if (part === 'outer') {
      call.call.objects[2] = 1;
      nativeWrite(f.old).valueObject = 1;
    }
    argumentGraph(f.old, [
      { path: [], object: part === 'outer' ? 1 : 2 },
      { path: ['0'], object: part === 'element' ? 8 : 3 },
      { path: ['0', 'deep'], object: 9 },
    ]);
    expect(judge(f).kind).toBe('unproven');
  });
  it('requires exact merge versus set for setIn even when their literal value bytes are equal', () => {
    const f = fixture('setIn');
    const call = writeOf(f.old);
    call.method = 'setObject';
    call.call.args.push(fact(UNDEF));
    call.call.objects.push(undefined);
    nativeWrite(f.old).method = 'set';
    expect(judge(f).kind).toBe('unproven');
  });
  it('rejects a missing fallback profile instead of treating it as no fallback', () => {
    const f = fixture('push');
    f.old.read.memoryGets = undefined;
    expect(judge(f).kind).toBe('unproven');
  });
});

function aliasedBatch() {
  const f = fixture('batch');
  const readValue = [{ z: {} }, { z: {} }];
  f.old = side(readValue, [{ value: [...readValue, null], id: 2 }]);
  readGraph(f.old, [
    { path: [], object: 1 },
    { path: ['0'], object: 8 },
    { path: ['0', 'z'], object: 9 },
    { path: ['1'], object: 8 },
    { path: ['1', 'z'], object: 9 },
  ]);
  argumentGraph(f.old, [
    { path: [], object: 2 },
    { path: ['0'], object: 3 },
    { path: ['0', 'z'], object: 4 },
    { path: ['1'], object: 3 },
    { path: ['1', 'z'], object: 4 },
  ]);
  return f;
}
describe('closed deep-copy prefix graph law', () => {
  it('preserves a declared local alias partition while every output ID is disjoint from the read', () => {
    expect(judge(aliasedBatch()).kind).toBe('declared-chart-branches');
  });
  it.each(['split', 'collapse', 'source-share', 'missing-root', 'partial', 'cycle', 'opaque', 'ref'])(
    'refuses %s without any equality-to-identity inference',
    (damage) => {
      const f = aliasedBatch();
      const call = writeOf(f.old);
      const graph = call.call.identities[2];
      if (damage === 'split') graph.find((row: any) => JSON.stringify(row.path) === '["1"]').object = 99;
      if (damage === 'collapse') {
        f.old.read.resultIdentities.find((row: any) => JSON.stringify(row.path) === '["1"]').object = 10;
        f.old.read.resultIdentities.find((row: any) => JSON.stringify(row.path) === '["1","z"]').object = 11;
      }
      if (damage === 'source-share') graph.find((row: any) => JSON.stringify(row.path) === '["0","z"]').object = 9;
      if (damage === 'missing-root') graph.shift();
      if (damage === 'partial') f.old.read.resultIdentities.pop();
      if (damage === 'cycle') f.old.read.resultIdentities[1].object = 1;
      if (damage === 'opaque') f.old.read.result.entries[0][2] = { kind: 'opaque' };
      if (damage === 'ref') f.old.read.result.entries[0][2] = { kind: 'ref', ref: 1 };
      expect(judge(f).kind).toBe('unproven');
    },
  );
});

describe('the existing native delivery domains remain explicit', () => {
  it('uses direct-delivered derived input after its carrier has established the propagation anchor', () => {
    const f = fixture('batch');
    for (const bound of [f.old, f.now]) {
      bound.native.events = bound.native.events.filter((row: any) => row.tier !== 'memory-get');
      for (const read of bound.branch.calls.filter((row: any) => row.phase === 'read')) {
        read.memoryGets = [];
        bound.native.events.find((row: any) => row.id === read.gets[0]).result = read.result;
      }
      // No fresh deleted-input claim at this already established destination.
      bound.native.events[0].method = 'set';
      bound.native.events[0].value = bound.read.result;
      bound.native.events[0].valueObject = bound.read.resultObject;
    }
    expect(judge(f).kind).toBe('declared-chart-branches');
    expect(judge(f).kind).not.toBe('cause');
  });
  it('retains canonical own-base provenance without inventing missing memory events', () => {
    const f = fixture('push');
    for (const bound of [f.old, f.now]) {
      bound.native.events = bound.native.events.filter((row: any) => row.tier !== 'memory-get');
      for (const read of bound.branch.calls.filter((row: any) => row.phase === 'read')) {
        read.memoryGets = undefined;
        read.heapBefore = undefined;
        read.heapAfter = undefined;
        bound.native.events.find((row: any) => row.id === read.gets[0]).base = {
          found: true,
          value: f.old.read.result,
        };
      }
    }
    expect(judge(f).kind).toBe('declared-chart-branches');
  });
  it('never treats an unprofiled read with absent own-base facts as an empty fallback', () => {
    const f = fixture('batch');
    f.old.native.events = f.old.native.events.filter((row: any) => row.tier !== 'memory-get');
    f.old.read.memoryGets = undefined;
    f.old.native.events.find((row: any) => row.id === f.old.read.gets[0]).base = { found: false, value: fact(UNDEF) };
    expect(judge(f).kind).toBe('unproven');
  });
});
