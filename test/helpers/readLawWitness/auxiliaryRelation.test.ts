/** Inert full-relation controls; archived JSON never supplies native identity authority. */
import { describe, expect, it } from 'vitest';

import { type ObservedKept, bindRetainedPairs, pairObservedReads } from '../readBindings.js';
import { readLawPorts } from '../readLawPorts.js';
import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { decideWitness, formatWitnessDecision } from '../witnessDecision.js';
import { readRetention124 } from './index.js';
import { equalNativeTrace, nativeTraceComparison } from './readPair.js';
import type { ReadPair } from './types.js';

const missing: ValueFact = { kind: 'undefined' };
const stale: ValueFact = { kind: 'array', value: 0, entries: [] };
const coordinate = ['chart', 0, 'stages', 0, 'invocation', 0, 'op', 0];
const args: readonly ValueFact[] = [
  { kind: 'array', value: 0, entries: [] },
  { kind: 'string', value: 'x' },
];
function fixture() {
  const make = (build: boolean): ObservedKept => {
    const header = { stageId: 's0', runId: build ? 'candidate' : 'reference', runtimeStageId: 's0#0' };
    const primary: NativeFact = {
      id: 3,
      start: 3,
      end: 6,
      leg: 'run',
      tier: 'stage-call',
      method: 'getValue',
      outcome: 'returned',
      phase: 'read',
      frame: 1,
      header,
      operation: coordinate,
      call: { args, objects: [2, undefined] },
      result: build ? missing : stale,
      gets: [4],
      ...(build ? { resultIdentities: [] } : { resultObject: 10, resultIdentities: [{ path: [], object: 10 }] }),
      retention: {
        nativeId: 3,
        frame: 1,
        key: 'x',
        value: build ? missing : stale,
        eligibility: { layout: build ? 'build-own-policy' : 'baseline-own-readTracking', mode: 'full' },
      },
    };
    const events: NativeFact[] = [
      {
        id: 1,
        start: 1,
        end: 2,
        leg: 'run',
        tier: 'buffer-call',
        method: 'delete',
        outcome: 'returned',
        phase: 'write',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
      },
      primary,
      {
        id: 4,
        start: 4,
        end: 5,
        leg: 'run',
        tier: 'buffer-call',
        method: 'get',
        outcome: 'returned',
        phase: 'read',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
        result: missing,
        base: { found: true, value: stale, object: 10 },
      },
    ];
    if (!build)
      events.push(
        { ...primary, id: 7, start: 7, end: 10, method: 'getValueDirect', gets: [8], retention: undefined },
        { ...events[2], id: 8, start: 8, end: 9 },
      );
    events.push({
      id: 20,
      start: 20,
      end: 25,
      leg: 'run',
      tier: 'buffer-call',
      method: 'commit',
      outcome: 'returned',
      phase: 'commit',
      frame: 1,
      header,
      buffer: 1,
      epoch: 0,
      encoder: {
        method: 'toChangeOnlyPayload',
        start: 21,
        end: 23,
        bytes: 'same-original-encoder-bytes',
        mode: 'full',
      },
    });
    const tree = JSON.stringify({
      id: 's0',
      runtimeStageId: 's0#0',
      stageReads: { x: build ? '«undefined»' : [] },
      kept: 9,
    });
    const span: OperationSpan = {
      coordinate,
      programPath: ['stages', 0, 0],
      path: [],
      start: 2.5,
      end: build ? 7 : 15,
      outcome: 'returned',
      edits: [],
    };
    return {
      kept: { executionTree: tree, sharedState: '{}', errors: '', cp1: '{"exact":true}' },
      commits: [{ bytes: 'same-original-encoder-bytes', foldsBack: true, nativeId: 20 }],
      program: JSON.stringify({ stages: [[{ t: 'read', k: 'x' }]] }),
      native: { leg: 'run', events, issues: [] },
      operations: [span],
    };
  };
  const a = make(false);
  const b = make(true);
  const qualified = pairObservedReads(a, b);
  if (qualified.kind !== 'bindings') throw new Error(qualified.reason);
  const bound = bindRetainedPairs(a, b, 'chart', qualified.reads);
  if (bound.kind !== 'retained-bindings') throw new Error(bound.reason);
  return { a, b, pairs: [...bound.pairs] };
}
type Fixture = ReturnType<typeof fixture>;
const verdict = (f: Fixture) => readRetention124(f.a, f.b, f.pairs);
const aux = (f: Fixture) => f.a.native.events.find(({ id }) => id === 7)!;
const eventList = (run: ObservedKept) => run.native.events as NativeFact[];

describe('full #124 auxiliary relation — inert native/retained proof records', () => {
  it('recomputes the actual profile, preserves all other strings, and reports exact count/underlying-object facts', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const result = verdict(f);
    expect(result).toEqual({
      kind: 'related',
      name: 'read-after-delete-124',
      nativeTrace: nativeTraceComparison(f.pairs),
      coordinates: [[...coordinate, 'native-read', 0]],
      auxiliary: {
        auxiliaryReadCount: 1,
        profiles: [
          {
            profile: 'root-array-json-operand-v1',
            coordinate,
            primary: { baselineNativeId: 3, buildNativeId: 3, baselineObject: 10 },
            auxiliaryReadCount: 1,
            receiverFacts: [{ kind: 'original-getValueDirect-return', nativeReadId: 7, primaryReadId: 3, object: 10 }],
          },
        ],
      },
    });
    expect(JSON.stringify(f)).toBe(before);
  });

  it('carries the same metadata through the real readLawPorts/Decision/report data path', () => {
    const f = fixture();
    const relation = verdict(f);
    if (relation.kind !== 'related') throw new Error(relation.reason);
    const ports = readLawPorts(f.a, f.b, 'chart', () => {
      throw new Error('no first changed commit');
    });
    const retained = ports.retainedReadCause!();
    expect(retained).toEqual(relation);
    const decision = decideWitness(f.a.commits, f.b.commits, {
      differs: true,
      sameCommit: (a, b) => a === b,
      ...ports,
    });
    expect(decision).toEqual({
      kind: 'cause',
      name: 'read-after-delete-124',
      shape: 'retained-only',
      nativeTrace: relation.nativeTrace,
      coordinates: relation.coordinates,
      auxiliary: relation.auxiliary,
    });
    expect(formatWitnessDecision(decision)).toBe(''); // Existing diagnostic contract remains exact.
    const report = JSON.parse(JSON.stringify({ decision })) as { decision: { auxiliary?: unknown } };
    expect(report.decision.auxiliary).toEqual(relation.auxiliary);
  });

  it.each(['sharedState', 'errors', 'cp1', 'commitLog'])(
    'valid auxiliary evidence cannot clear independent kept %s corruption',
    (field) => {
      const f = fixture();
      f.b = { ...f.b, kept: { ...f.b.kept, [field]: 'independent corruption' } };
      expect(verdict(f).kind).toBe('unproven');
    },
  );

  it('valid auxiliary evidence cannot clear a different native read outside the operation window', () => {
    const f = fixture();
    const ordinary: NativeFact = {
      ...f.a.native.events[1],
      id: 30,
      start: 30,
      end: 31,
      operation: ['chart', 'other'],
      gets: [],
      result: { kind: 'number', value: '1' },
      resultObject: undefined,
      resultIdentities: [],
      retention: undefined,
    };
    eventList(f.a).push(ordinary);
    eventList(f.b).push({ ...ordinary, result: { kind: 'number', value: '2' } });
    expect(verdict(f).kind).toBe('unproven');
  });

  it('compares outside actor placement at the record level while native semantics stay exact', () => {
    const f = fixture();
    const mapper: NativeFact = {
      id: 26,
      start: 26,
      end: 27,
      leg: 'run',
      tier: 'stage-call',
      method: 'setGlobal',
      phase: 'write',
      outcome: 'returned',
      frame: 8,
      header: { stageId: 'seed-inner', runtimeStageId: '', runId: '' },
      call: {
        args: [
          { kind: 'string', value: 'a' },
          { kind: 'string', value: 'none' },
        ],
        objects: [undefined, undefined],
      },
    };
    eventList(f.a).push(mapper);
    eventList(f.b).push({ ...mapper, frame: 9, header: { stageId: 'mount', runtimeStageId: 'mount#0', runId: '' } });
    const relation = verdict(f);
    expect(relation.kind).toBe('related');
    if (relation.kind !== 'related') throw new Error(relation.reason);
    expect(relation.nativeTrace).toEqual(nativeTraceComparison(f.pairs));
  });

  const negatives: readonly { label: string; damage: (f: Fixture) => void }[] = [
    {
      label: 'copied equal baseline span instead of actual member reference',
      damage: (f) => {
        f.pairs = f.pairs.map((pair) => ({
          ...pair,
          operationSpans: {
            baseline: { ...pair.operationSpans!.baseline },
            build: pair.operationSpans!.build,
          },
        }));
      },
    },
    {
      label: 'missing original operations port',
      damage: (f) => {
        f.a = { ...f.a, operations: [] };
      },
    },
    {
      label: 'an equal JSON-copied operations array with old pair references',
      damage: (f) => {
        f.a = { ...f.a, operations: JSON.parse(JSON.stringify(f.a.operations)) };
      },
    },
    {
      label: 'duplicate actual member reference',
      damage: (f) => {
        f.a = { ...f.a, operations: [f.a.operations[0], f.a.operations[0]] };
      },
    },
    {
      label: 'duplicate primary/auxiliary claim',
      damage: (f) => {
        f.pairs.push(f.pairs[0]);
      },
    },
    {
      label: 'another native event reuses an excluded auxiliary ID',
      damage: (f) => {
        eventList(f.a).push({ ...aux(f), start: 30, end: 31, operation: ['other'] });
      },
    },
    {
      label: 'extra auxiliary with a different underlying object',
      damage: (f) => {
        eventList(f.a).splice(5, 0, {
          ...aux(f),
          id: 11,
          start: 11,
          end: 12,
          gets: [],
          resultObject: 99,
          resultIdentities: [{ path: [], object: 99 }],
        });
      },
    },
    {
      label: 'unclaimed auxiliary outside the actual span',
      damage: (f) => {
        eventList(f.a).push({ ...aux(f), id: 30, start: 30, end: 31, gets: [] });
      },
    },
    {
      label: 'candidate extra read',
      damage: (f) => {
        eventList(f.b).splice(3, 0, {
          ...f.b.native.events[1],
          id: 7,
          start: 7,
          end: 10,
          method: 'getValueDirect',
          retention: undefined,
          gets: [],
        });
      },
    },
    {
      label: 'staged write inside the claimed read-only operation',
      damage: (f) => {
        eventList(f.a).splice(5, 0, {
          ...f.a.native.events[0],
          id: 11,
          start: 11,
          end: 12,
          method: 'set',
          value: { kind: 'number', value: '8' },
        });
      },
    },
    {
      label: 'extra actual native commit not represented by an outer witness',
      damage: (f) => {
        const commit = f.a.native.events.find(({ id }) => id === 20)!;
        eventList(f.a).push({
          ...commit,
          id: 30,
          start: 30,
          end: 35,
          encoder: {
            method: 'toChangeOnlyPayload',
            start: 31,
            end: 33,
            bytes: 'unclaimed actual encoder',
            mode: 'full',
          },
        });
      },
    },
    {
      label: 'native commits do not occur in their witnessed order',
      damage: (f) => {
        const commit = f.a.native.events.find(({ id }) => id === 20)!;
        eventList(f.a).push({
          ...commit,
          id: 30,
          start: 30,
          end: 35,
          encoder: { method: 'toChangeOnlyPayload', start: 31, end: 33, bytes: 'second actual encoder', mode: 'full' },
        });
        f.a = { ...f.a, commits: [{ bytes: 'second actual encoder', nativeId: 30, foldsBack: true }, ...f.a.commits] };
        f.b = { ...f.b, commits: f.a.commits };
        const buildCommit = f.b.native.events.find(({ id }) => id === 20)!;
        eventList(f.b).push({
          ...buildCommit,
          id: 30,
          start: 30,
          end: 35,
          encoder: { method: 'toChangeOnlyPayload', start: 31, end: 33, bytes: 'second actual encoder', mode: 'full' },
        });
      },
    },
    {
      label: 'changed inner encoder despite identical outer commit',
      damage: (f) => {
        const commit = f.b.native.events.find(({ id }) => id === 20)!;
        Object.assign(commit, { encoder: { ...commit.encoder, bytes: 'inner rewrite' } });
      },
    },
    {
      label: 'changed outer commit',
      damage: (f) => {
        f.b = { ...f.b, commits: [{ ...f.b.commits[0], bytes: 'outer rewrite' }] };
      },
    },
    {
      label: 'non-folding BUILD commit',
      damage: (f) => {
        f.b = { ...f.b, commits: [{ ...f.b.commits[0], foldsBack: false }] };
      },
    },
    {
      label: 'equal auxiliary values with different object identity',
      damage: (f) => {
        Object.assign(aux(f), { resultObject: 99, resultIdentities: [{ path: [], object: 99 }] });
      },
    },
    {
      label: 'a context ID substituted for underlying-object identity',
      damage: (f) => {
        Object.assign(aux(f), { resultObject: 1, resultIdentities: [{ path: [], object: 1 }] });
      },
    },
    {
      label: 'missing retained read sites',
      damage: (f) => {
        f.pairs = f.pairs.map((pair) => ({ ...pair, sites: [] }));
      },
    },
  ];
  it.each(negatives)('full relation refuses $label', ({ damage }) => {
    const f = fixture();
    damage(f);
    expect(verdict(f).kind).toBe('unproven');
  });

  it('a caller-supplied auxiliary ID list cannot authorize exclusions', () => {
    const f = fixture();
    Object.assign(f.pairs[0], { auxiliaryIds: [7], auxiliaryReadCount: 1 });
    f.pairs = f.pairs.map((pair): ReadPair => ({ ...pair, operationSpans: undefined }));
    expect(verdict(f).kind).toBe('unproven');
  });
});

// STATIC AUTHOR DRAFT — UNRUN. Append to auxiliaryRelation.test.ts after the existing fixture helpers.
// Add equalNativeTrace to its existing readLawWitness/readPair import (or import it from ./readPair.js).
function withAuxiliaryHeap() {
  const f = fixture();
  const read = aux(f);
  const point = (at: number) => ({
    layout: 'baseline-stage-shared-memory' as const,
    at,
    memory: 99,
    generation: 100,
    facts: { kind: 'object', entries: [] } as ValueFact,
  });
  // An inert, internally ordered original fallback under auxiliary7; no native source executes here.
  Object.assign(read, { end: 16, heapBefore: point(8), heapAfter: point(15), memoryGets: [11], gets: [9] });
  const oldGet = f.a.native.events.find(({ id }) => id === 8)!;
  Object.assign(oldGet, { id: 9, start: 9, end: 10 });
  const memory: NativeFact = {
    id: 11,
    start: 11,
    end: 14,
    leg: 'run',
    tier: 'memory-get',
    method: 'getValue',
    phase: 'read',
    outcome: 'returned',
    parentRead: read.id,
    receiverObject: 99,
    frame: read.frame,
    header: read.header,
    operation: read.operation,
    heapBefore: point(12),
    heapAfter: point(13),
    result: stale,
    resultObject: 10,
    resultIdentities: [{ path: [], object: 10 }],
  };
  eventList(f.a).splice(5, 0, memory);
  const span = f.a.operations[0];
  Object.assign(span, { end: 18 }); // Preserve the SAME original member object; update the corresponding inert bound.
  f.pairs = f.pairs.map((pair) => ({ ...pair, baseline: { ...pair.baseline, end: 18 } }));
  return { f, read, memory };
}

describe('origin validation sees the complete original auxiliary call chain', () => {
  it('retains the auxiliary stage parent and its real memory-get rows while excluding only its semantic row', () => {
    const { f, read, memory } = withAuxiliaryHeap();
    const before = JSON.stringify(f);
    const result = verdict(f);
    expect(result.kind).toBe('related'); // RED under the earlier detached-filtered-receipt design: memory11 was orphaned.
    expect(f.a.native.events.includes(read)).toBe(true);
    expect(f.a.native.events.includes(memory)).toBe(true);
    expect(JSON.stringify(f)).toBe(before);
  });

  it.each(['parent', 'receiver', 'clock', 'missing-child'] as const)(
    'a semantic exclusion cannot waive bad original heap %s evidence',
    (kind) => {
      const { f, memory } = withAuxiliaryHeap();
      if (kind === 'parent') Object.assign(memory, { parentRead: 999 });
      if (kind === 'receiver') Object.assign(memory, { receiverObject: 1000 });
      if (kind === 'clock') Object.assign(memory, { start: 7 });
      if (kind === 'missing-child')
        f.a = { ...f.a, native: { ...f.a.native, events: f.a.native.events.filter((event) => event !== memory) } };
      expect(verdict(f).kind).toBe('unproven');
    },
  );

  it('rejects an equal copied semantic row instead of an original member reference', () => {
    const { f, read } = withAuxiliaryHeap();
    expect(() => equalNativeTrace(f.a.native, f.b.native, f.pairs, new Set([{ ...read }]))).toThrow(
      'unique original auxiliary stage-read reference',
    );
  });

  it('rejects a memory row, the primary read, or an arbitrary supplied ID as semantic authority', () => {
    const { f, memory } = withAuxiliaryHeap();
    for (const row of [memory, f.a.native.events.find(({ id }) => id === 3)!]) {
      expect(() => equalNativeTrace(f.a.native, f.b.native, f.pairs, new Set([row]))).toThrow(
        'unique original auxiliary stage-read reference',
      );
    }
    // The relation still accepts no exclusion argument at all: only its own recomputed profile can create one.
    Object.assign(f.pairs[0], { auxiliaryIds: [7] });
    f.pairs = f.pairs.map((pair) => ({ ...pair, operationSpans: undefined }));
    expect(verdict(f).kind).toBe('unproven');
  });
});

describe('native comparison domain follows 0cbc while windows remain independently strict', () => {
  function prefixActors() {
    const f = fixture();
    const stage = (frame: number, stageId: string): NativeFact => ({
      id: 90,
      start: 0.1,
      end: 0.9,
      leg: 'run',
      tier: 'stage-call',
      method: 'setGlobal',
      phase: 'write',
      outcome: 'returned',
      frame,
      header: { stageId, runtimeStageId: stageId, runId: '' },
      call: {
        args: [
          { kind: 'string', value: 'other' },
          { kind: 'number', value: '7' },
        ],
        objects: [undefined, undefined],
      },
    });
    const left = stage(77, 'old-seed');
    const right = stage(1, 'new-mount');
    const write = (parent: NativeFact): NativeFact => ({
      id: 91,
      start: 0.3,
      end: 0.6,
      leg: 'run',
      tier: 'buffer-call',
      method: 'set',
      phase: 'write',
      outcome: 'returned',
      frame: parent.frame,
      header: parent.header,
      buffer: parent.frame,
      epoch: 0,
      address: ['other'],
      value: { kind: 'number', value: '7' },
    });
    eventList(f.a).unshift(left, write(left));
    eventList(f.b).unshift(right, write(right));
    return f;
  }

  it('outside actor history cannot shift the local frame/buffer ordinals of an otherwise proved window', () => {
    const f = prefixActors();
    const relation = verdict(f);
    expect(relation.kind).toBe('related');
    if (relation.kind !== 'related') throw new Error(relation.reason);
    expect(relation.nativeTrace).toEqual(nativeTraceComparison(f.pairs));
    expect(relation.nativeTrace.crossEngineFields).toBe('semantic');
    expect(relation.nativeTrace.actorIdentity).toBe('record-level (r13 view)');
  });

  it.each(['address', 'value', 'order'] as const)(
    'outside %s semantics remain exact despite the actor view',
    (damage) => {
      const f = prefixActors();
      const write = f.b.native.events.find(({ id }) => id === 91)!;
      if (damage === 'address') Object.assign(write, { address: ['wrong'] });
      if (damage === 'value') Object.assign(write, { value: { kind: 'number', value: '8' } });
      if (damage === 'order') eventList(f.b).reverse();
      expect(verdict(f).kind).toBe('unproven');
    },
  );

  it.each(['wrong-return', 'missing'] as const)(
    'a %s native observation in the proved window still refuses',
    (damage) => {
      const f = prefixActors();
      if (damage === 'wrong-return') Object.assign(f.b.native.events.find(({ id }) => id === 3)!, { result: stale });
      else f.b = { ...f.b, native: { ...f.b.native, events: f.b.native.events.filter(({ id }) => id !== 3) } };
      expect(verdict(f).kind).toBe('unproven');
    },
  );

  it('native actor viewing cannot clear independent record corruption', () => {
    const f = prefixActors();
    f.b = { ...f.b, kept: { ...f.b.kept, errors: 'independent record corruption' } };
    expect(verdict(f).kind).toBe('unproven');
  });
});
// Existing full-relation encoder rewrite/count/order controls stay exact. The carrier additionally owns the
// first-commit-prefix test that changes ONLY a prior native encoder beside a valid first-boundary cause.
