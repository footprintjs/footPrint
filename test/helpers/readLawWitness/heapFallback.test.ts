import { describe, expect, it } from 'vitest';

import type { HeapPoint, NativeFact, Receipt, ValueFact } from '../readWitness.js';
import { requireHeapFallback } from './heapFallback.js';
import { checkedPair, equalNativeTrace } from './readPair.js';
import type { ReadPair } from './types.js';

// These inert receipts deliberately give the two engines DIFFERENT local heap IDs.
// They test the relation, not the existence of any real native implementation.
const undef: ValueFact = { kind: 'undefined' };
const number: ValueFact = { kind: 'number', value: '7' };
const heapFacts: ValueFact = { kind: 'object', entries: [['x0', true, number]] };
const coordinate = ['inert', 0] as const;
function side(build = false) {
  const id = build ? 500 : 5;
  const layout = build ? ('build-record-state' as const) : ('baseline-stage-shared-memory' as const);
  const point = (at: number): HeapPoint => ({ layout, at, memory: id, generation: id + 1, facts: heapFacts });
  const header = { stageId: 'S', runtimeStageId: '', runId: 'r1' };
  const deletedBy: NativeFact = {
    id: 10,
    start: 10,
    end: 15,
    leg: 'L',
    tier: 'buffer-call',
    phase: 'write',
    method: 'delete',
    outcome: 'returned',
    frame: 1,
    header,
    buffer: 1,
    epoch: 0,
    address: ['runs', 'r1', 'x0'],
    heapBefore: point(11),
    heapAfter: point(14),
  };
  const get: NativeFact = {
    id: 22,
    start: 22,
    end: 24,
    leg: 'L',
    tier: 'buffer-call',
    phase: 'read',
    method: 'get',
    outcome: 'returned',
    frame: 1,
    header,
    buffer: 1,
    epoch: 0,
    operation: coordinate,
    address: ['runs', 'r1', 'x0'],
    base: { found: false, value: undef },
    result: undef,
  };
  const path: ValueFact = { kind: 'array', value: 0, entries: [] };
  const read: NativeFact = {
    id: 20,
    start: 20,
    end: 39,
    leg: 'L',
    tier: 'stage-call',
    phase: 'read',
    method: 'getValue',
    outcome: 'returned',
    frame: 1,
    header,
    operation: coordinate,
    call: { args: [path, { kind: 'string', value: 'x0' }], objects: [300, undefined] },
    heapBefore: point(21),
    heapAfter: point(38),
    gets: [22],
    memoryGets: build ? [] : [25],
    result: build ? undef : number,
  };
  const memory: NativeFact = {
    id: 25,
    start: 25,
    end: 34,
    leg: 'L',
    tier: 'memory-get',
    phase: 'read',
    method: 'getValue',
    outcome: 'returned',
    frame: 1,
    header,
    operation: coordinate,
    parentRead: 20,
    receiverObject: id,
    heapBefore: point(26),
    heapAfter: point(33),
    result: number,
    call: {
      args: [{ kind: 'string', value: 'r1' }, path, { kind: 'string', value: 'x0' }],
      objects: [undefined, 300, undefined],
    },
  };
  const receipt: Receipt = {
    leg: 'L',
    issues: [],
    events: build ? [deletedBy, read, get] : [deletedBy, read, get, memory],
  };
  return { receipt, read, get, deletedBy, memory };
}
function fixture() {
  const a = side();
  const b = side(true);
  const bound = { coordinate, frame: 1, start: 19, end: 40, nativeId: 20, occurrence: 0 };
  const pair: ReadPair = { baseline: bound, build: { ...bound }, sites: [] };
  return { a, b, pair };
}
const change = <T extends object>(object: T, patch: Partial<T>): void => {
  Object.assign(object, patch);
};

describe('original heap fallback: closed alternate provenance', () => {
  it('joins the exact memory call with unchanged own heaps and never compares IDs between engines', () => {
    const { a, b, pair } = fixture();
    const [x, y] = checkedPair(a.receipt, b.receipt, pair);
    expect(requireHeapFallback(a.receipt, b.receipt, x, y)).toEqual({
      name: 'original-heap-fallback',
      baselineCall: 25,
      baselineReceiver: 5,
      baselineGeneration: 6,
      buildReceiver: 500,
      buildGeneration: 501,
    });
    expect(equalNativeTrace(a.receipt, b.receipt, [pair])).toBe(true);
  });

  it('preserves canonical own-base admission with no optional profile on either side', () => {
    const { a, b, pair } = fixture();
    for (const input of [a, b]) {
      change(input.get, { base: { found: true, value: number } });
      change(input.read, { memoryGets: undefined, heapBefore: undefined, heapAfter: undefined });
      change(input.receipt, { events: [input.deletedBy, input.read, input.get] });
    }
    expect(() => checkedPair(a.receipt, b.receipt, pair)).not.toThrow();
    expect(equalNativeTrace(a.receipt, b.receipt, [pair])).toBe(true);
  });

  it('requires the SAME original returned object, even when another object has equal detached facts', () => {
    const { a, b, pair } = fixture();
    const result: ValueFact = { kind: 'object', entries: [['n', true, number]] };
    change(a.read, { result, resultObject: 700 });
    change(a.memory, { result, resultObject: 700 });
    expect(() => checkedPair(a.receipt, b.receipt, pair)).not.toThrow();
    change(a.memory, { resultObject: 701 });
    expect(() => checkedPair(a.receipt, b.receipt, pair)).toThrow();
  });

  const damage: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'profile omitted': ({ a }) => change(a.read, { memoryGets: undefined }),
    'no actual old call': ({ a }) => {
      change(a.read, { memoryGets: [] });
      change(a.receipt, { events: [a.deletedBy, a.read, a.get] });
    },
    'two original memory calls': ({ a, pair }) => {
      const second = {
        ...a.memory,
        id: 35,
        start: 35,
        end: 38,
        heapBefore: { ...a.memory.heapBefore!, at: 36 },
        heapAfter: { ...a.memory.heapAfter!, at: 37 },
      };
      change(a.read, { memoryGets: [25, 35], heapAfter: { ...a.read.heapAfter!, at: 40 }, end: 41 });
      change(pair.baseline, { end: 42 });
      change(a.receipt, { events: [...a.receipt.events, second] });
    },
    'call belongs to another native read': ({ a }) => change(a.memory, { parentRead: 99 }),
    'call came from another owning memory': ({ a }) => change(a.memory, { receiverObject: 90 }),
    'call is outside the native read': ({ a }) => change(a.memory, { end: 42 }),
    'call is before its actual buffer get': ({ a }) => change(a.get, { end: 27 }),
    'different original run argument': ({ a }) =>
      change(a.memory, {
        call: { ...a.memory.call!, args: [{ kind: 'string', value: 'r2' }, ...a.memory.call!.args.slice(1)] },
      }),
    'equal path contents but another path identity': ({ a }) =>
      change(a.memory, { call: { ...a.memory.call!, objects: [undefined, 301, undefined] } }),
    'different original key': ({ a }) =>
      change(a.memory, {
        call: { ...a.memory.call!, args: [...a.memory.call!.args.slice(0, 2), { kind: 'string', value: 'other' }] },
      }),
    'different logical run ID': ({ b }) => change(b.read, { header: { ...b.read.header!, runId: 'r2' } }),
    'original call threw': ({ a }) => change(a.memory, { outcome: 'threw' }),
    'equal data but different raw result identity': ({ a }) => change(a.memory, { resultObject: 90 }),
    'candidate still returns stale data': ({ b }) => change(b.read, { result: number }),
    'generation swapped during read': ({ a }) =>
      change(a.memory, { heapAfter: { ...a.memory.heapAfter!, generation: 60 } }),
    'heap edited in place during read': ({ a }) =>
      change(a.memory, { heapAfter: { ...a.memory.heapAfter!, facts: undef } }),
    'pre-delete facts differ across engines': ({ b }) => {
      const facts = { kind: 'object', entries: [] };
      change(b.deletedBy, {
        heapBefore: { ...b.deletedBy.heapBefore!, facts },
        heapAfter: { ...b.deletedBy.heapAfter!, facts },
      });
      change(b.read, { heapBefore: { ...b.read.heapBefore!, facts }, heapAfter: { ...b.read.heapAfter!, facts } });
    },
    'tombstone lacks heap provenance': ({ a }) => change(a.deletedBy, { heapBefore: undefined }),
    'candidate also falls through to heap': ({ b }) => {
      change(b.memory, {
        heapBefore: { ...b.read.heapBefore!, at: 26 },
        heapAfter: { ...b.read.heapAfter!, at: 33 },
        receiverObject: 500,
      });
      change(b.read, { memoryGets: [25] });
      change(b.receipt, { events: [...b.receipt.events, b.memory] });
    },
    'another frame tombstone': ({ a }) => change(a.deletedBy, { frame: 2 }),
    'another buffer epoch': ({ a }) => change(a.deletedBy, { epoch: 1 }),
    'reestablished value before read': ({ a }) =>
      change(a.receipt, {
        events: [
          a.deletedBy,
          { ...a.deletedBy, id: 16, start: 16, end: 18, method: 'set', value: number },
          a.read,
          a.get,
          a.memory,
        ],
      }),
  };
  for (const [name, mutate] of Object.entries(damage))
    it(`refuses ${name}`, () => {
      const f = fixture();
      mutate(f);
      expect(() => checkedPair(f.a.receipt, f.b.receipt, f.pair)).toThrow();
    });

  it('does not turn a new native tier or an unbound memory-get into a generic trace exemption', () => {
    const { a, b, pair } = fixture();
    change(a.memory, { tier: 'unknown-native' as NativeFact['tier'] });
    expect(() => equalNativeTrace(a.receipt, b.receipt, [pair])).toThrow();
    change(a.memory, { tier: 'memory-get', parentRead: 99 });
    expect(() => equalNativeTrace(a.receipt, b.receipt, [pair])).toThrow();
  });
});
