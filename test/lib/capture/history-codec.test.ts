import { expect, it } from 'vitest';

import { copyHistoryData, historyDigest } from '../../../src/lib/capture/historyData.js';
import { historyNote } from '../../../src/lib/capture/historyNote.js';
import { copyHistoryReceipt, copyHistoryTarget } from '../../../src/lib/capture/historyTarget.js';
import { NativeCapture } from '../../../src/lib/capture/nativeCoverage.js';

const target = {
  version: 1 as const,
  runId: 'run',
  evidenceId: 'run',
  digest: 'a'.repeat(64),
  logAddress: { logRunId: 'run', drillPath: [] },
  commits: { from: 0, to: 1 },
};
function note() {
  const capture = new NativeCapture('run', target.logAddress, 0, {
    readTracking: 'full',
    writeTracking: 'full',
    commitValues: 'full',
    writeProvenance: 'reads-prefix',
  });
  capture.end('completed');
  return JSON.parse(JSON.stringify(capture.snapshot(1, 'captured')));
}

it('accepts only a fixed, bounded target and receipt and discards additional provider receipt fields', () => {
  const copied = copyHistoryTarget(target)!;
  expect(copied).toEqual(target);
  expect(copyHistoryReceipt({ ...target, durability: 'durable', providerSecret: 'not exported' }, copied)).toEqual({
    ...target,
    durability: 'durable',
  });
  expect(copyHistoryReceipt({ ...target, durability: 'queued' }, copied)).toBeUndefined();
  expect(copyHistoryReceipt({ ...target, digest: 'b'.repeat(64), durability: 'durable' }, copied)).toBeUndefined();
});

it.each(['version', 'runId', 'evidenceId', 'digest', 'logAddress', 'commits'])(
  'refuses invalid target %s without coercion',
  (key) => {
    for (const value of [null, undefined, 0, -1, 1.5, false, {}, [], Symbol('id'), () => 0])
      expect(copyHistoryTarget({ ...target, [key]: value })).toBeUndefined();
  },
);

it('refuses target accessors, revoked proxies, oversized identities and invalid extents', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(copyHistoryTarget(proxy)).toBeUndefined();
  let called = 0;
  expect(
    copyHistoryTarget(
      Object.defineProperty({}, 'version', {
        get() {
          called++;
          return 1;
        },
      }),
    ),
  ).toBeUndefined();
  expect(called).toBe(0);
  for (const changes of [
    { runId: 'x'.repeat(2049) },
    { commits: { from: 2, to: 1 } },
    { commits: { from: -1, to: 2 } },
    { logAddress: { logRunId: 'run', drillPath: ['child'] } },
  ])
    expect(copyHistoryTarget({ ...target, ...changes })).toBeUndefined();
});

it('accepts a native note without turning it into storage authority', () => {
  const native = note();
  expect(historyNote(native, target)).toEqual(native);
  expect(historyNote(native, target)!.persistence).toBe('memory-only');
});

it.each([
  'version',
  'runId',
  'scope',
  'persistence',
  'boundary',
  'modes',
  'channels',
  'limitations',
  'logAddress',
  'commits',
])('refuses malformed native %s', (key) => {
  for (const invalid of [null, undefined, 0, false, {}, [], 'bad'])
    expect(historyNote({ ...note(), [key]: invalid }, target)).toBeUndefined();
});

it.each(['readTracking', 'writeTracking', 'commitValues', 'writeProvenance'])(
  'refuses unknown %s without importing a second vocabulary',
  (key) => {
    const native = note();
    native.modes[key] = 'unexpected';
    expect(historyNote(native, target)).toBeUndefined();
  },
);
it.each(['reads', 'writes', 'attention', 'control', 'readSources'])('refuses unknown channel %s', (key) => {
  const native = note();
  native.channels[key] = 'unexpected';
  expect(historyNote(native, target)).toBeUndefined();
});
it('refuses extra metadata, unknown gaps and missing base limitations', () => {
  for (const child of ['logAddress', 'commits', 'modes', 'channels', 'boundary']) {
    const native = note();
    native[child].private = true;
    expect(historyNote(native, target)).toBeUndefined();
  }
  expect(historyNote({ ...note(), private: true }, target)).toBeUndefined();
  for (const limitations of [[], Array(33).fill('tracked-state-only'), ['unknown-gap']])
    expect(historyNote({ ...note(), limitations }, target)).toBeUndefined();
});
it('keeps only safe native failure context, including cancellation, and rejects arbitrary error payloads', () => {
  const native = note();
  native.boundary = { status: 'failed', failure: { category: 'unknown' } };
  expect(historyNote(native, target)).toEqual(native);
  native.boundary.failure.stage = { runId: 'run', runtimeStageId: 'work#1' };
  expect(historyNote(native, target)).toEqual(native);
  native.boundary.status = 'cancelled';
  expect(historyNote(native, target)).toEqual(native);
  for (const failure of [
    { category: 'invented' },
    { category: 'unknown', raw: {} },
    { category: 'unknown', stage: { runId: 'other', runtimeStageId: 'a' } },
    { category: 'unknown', stage: { runId: 'run', runtimeStageId: 'x'.repeat(1025) } },
    { category: 'unknown', stage: { runId: 'run', runtimeStageId: 1 } },
    { category: 'unknown', stage: { runId: 'run', runtimeStageId: 'a', raw: {} } },
  ])
    expect(historyNote({ ...native, boundary: { status: 'failed', failure } }, target)).toBeUndefined();
  expect(
    historyNote({ ...native, boundary: { status: 'completed', failure: { category: 'unknown' } } }, target),
  ).toBeUndefined();
});

it('bounds inert data bytes, depth, nodes, cycles, prototypes and array loss without coercion', () => {
  const cyclic: any = {};
  cyclic.cycle = cyclic;
  const hole = new Array(1);
  const extra: any = [1];
  extra.more = 2;
  for (const value of [
    undefined,
    () => 0,
    Symbol('fixture'),
    BigInt(1),
    NaN,
    Infinity,
    -0,
    new Date(),
    new Map(),
    cyclic,
    hole,
    extra,
    [undefined],
    Object.create(null),
  ])
    expect(() => copyHistoryData(value, 100)).toThrow();
  let deep: any = {};
  for (let i = 0; i < 258; i++) deep = { deep };
  expect(() => copyHistoryData(deep, 10000)).toThrow();
  expect(() => copyHistoryData(Array(100001).fill(0), 1000000)).toThrow();
  expect(() => copyHistoryData('large', 2)).toThrow();
  expect(() => copyHistoryData('🎈', 5)).toThrow();
  expect(copyHistoryData({ a: undefined }, 100)).toEqual({});
  expect(copyHistoryData({ b: [null, true, 3, 'ok'] }, 100)).toEqual({ b: [null, true, 3, 'ok'] });
  const magic = JSON.parse('{"__proto__":{"polluted":true},"constructor":1}');
  expect(Object.getPrototypeOf(copyHistoryData(magic, 100))).toBe(Object.prototype);
  expect(({} as any).polluted).toBeUndefined();
});

it('digests the exact served JSON representation without inventing value canonicalization', async () => {
  expect(await historyDigest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  expect(await historyDigest({ a: 1 })).not.toBe(await historyDigest({ a: 2 }));
});

it('preserves generated JSON dictionaries exactly within the bounds', async () => {
  const fc = await import('fast-check');
  const scalar = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string({ maxLength: 40 }));
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 30 }), fc.oneof(scalar, fc.array(scalar, { maxLength: 8 })), {
        maxKeys: 15,
        noNullPrototype: true,
      }),
      (value) => {
        const result = copyHistoryData(value, 100_000);
        expect(JSON.stringify(result)).toBe(JSON.stringify(value));
        expect(Object.isFrozen(result)).toBe(true);
      },
    ),
    { seed: 1112026, numRuns: 128 },
  );
});

it('uses JSON object omission for arbitrary future metadata, including dotted names', () => {
  const value = {
    future: undefined,
    'next.stageReads': { field: undefined },
    nested: { optional: undefined, kept: 1 },
  };
  expect(copyHistoryData(value, 100)).toEqual(JSON.parse(JSON.stringify(value)));
  let calls = 0;
  const accessor = Object.defineProperty({}, 'future', {
    enumerable: true,
    get() {
      calls++;
      return undefined;
    },
  });
  expect(() => copyHistoryData(accessor, 100)).toThrow();
  expect(calls).toBe(0);
});
