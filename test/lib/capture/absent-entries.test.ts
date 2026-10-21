import { expect, it } from 'vitest';

import { copyCaptureEvidence, validateAbsentEntries } from '../../../src/lib/capture/absentEntries.js';
import { copyHistoryData } from '../../../src/lib/capture/historyData.js';

const read = ['executionTree', 'stageReads', 'missing'];
const evidence = () => ({ executionTree: { stageReads: { missing: undefined }, stageWrites: {} } });

it('keeps no-sidecar JSON bytes unchanged, and ignores optional metadata and nested business omissions', () => {
  const data = { executionTree: { stageReads: { value: { missing: undefined, kept: 2 } } }, optional: undefined };
  expect(JSON.stringify(copyCaptureEvidence(data, 10000))).toBe(JSON.stringify(copyHistoryData(data, 10000)));
});

it('keeps literal keys and sorts root, next and child paths by ordinal segments', () => {
  const writes = Object.defineProperty({ z: undefined, 'next.stageReads.x': undefined, a: undefined }, '__proto__', {
    value: undefined,
    enumerable: true,
  });
  const value = {
    executionTree: {
      stageReads: { missing: undefined },
      stageWrites: writes,
      next: { stageReads: { missing: undefined } },
      children: [{ stageWrites: { missing: undefined } }],
    },
  };
  const copied = copyCaptureEvidence(value, 10000);
  expect(copied.absent).toEqual([
    ['executionTree', 'children', '0', 'stageWrites', 'missing'],
    ['executionTree', 'next', 'stageReads', 'missing'],
    read,
    ['executionTree', 'stageWrites', '__proto__'],
    ['executionTree', 'stageWrites', 'a'],
    ['executionTree', 'stageWrites', 'next.stageReads.x'],
    ['executionTree', 'stageWrites', 'z'],
  ]);
  expect(validateAbsentEntries(copied)).toBe(true);
  expect(Object.isFrozen(copied.absent)).toBe(true);
  expect(Object.isFrozen((copied.absent as string[][])[0])).toBe(true);
  expect(({} as any).polluted).toBeUndefined();
});

it.each([
  null,
  {},
  [],
  [read, read],
  [read, ['executionTree', 'next', 'stageReads', 'missing']],
  [['recorders', 'stageReads', 'missing']],
  [['executionTree', 'stageReads']],
  [['executionTree', 'other', 'missing']],
  [['executionTree', 'children', '00', 'stageReads', 'missing']],
  [['executionTree', 'children', '999', 'stageReads', 'missing']],
  [['executionTree', 'next', 'stageReads', 'missing']],
  [['executionTree', 'stageReads', 3]],
  Array(4097).fill(read),
  [Array(257).fill('next')],
])('refuses malformed, out-of-scope, duplicate or unsorted paths %#', (absent) => {
  expect(validateAbsentEntries(copyHistoryData({ executionTree: { stageReads: {} }, absent }, 1000000) as any)).toBe(
    false,
  );
});

it('refuses contradictory present-key, scalar-map and array-map markers', () => {
  for (const stageReads of [{ missing: 1 }, 1, [], { missing: null }])
    expect(validateAbsentEntries({ executionTree: { stageReads }, absent: [read] })).toBe(false);
});

it('bounds sidecar growth without dropping entries and charges UTF-8 and combined body bytes', () => {
  const stageReads = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [String(i), undefined]));
  expect(() => copyCaptureEvidence({ executionTree: { stageReads } }, 1000000)).toThrow('too large');
  expect(() => copyCaptureEvidence(evidence(), 60)).toThrow('too large');
  expect(() => copyCaptureEvidence({ executionTree: { stageReads: { ['🎈'.repeat(100)]: undefined } } }, 200)).toThrow(
    'too large',
  );
  const copied = copyCaptureEvidence(evidence(), 10000);
  const bytes = new TextEncoder().encode(JSON.stringify(copied)).length;
  expect(copyCaptureEvidence(evidence(), bytes)).toEqual(copied);
  expect(() => copyCaptureEvidence(evidence(), bytes - 1)).toThrow('too large');
});

it('never calls getters or toJSON while collecting missing entries', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'missing', {
    enumerable: true,
    get() {
      calls++;
      return undefined;
    },
  });
  const toJSON = {
    toJSON() {
      calls++;
      return {};
    },
  };
  for (const stageReads of [accessor, toJSON])
    expect(() => copyCaptureEvidence({ executionTree: { stageReads } }, 10000)).toThrow();
  expect(calls).toBe(0);
});

it('refuses a retained event beyond the sidecar path-depth bound instead of silently omitting it', () => {
  let node: any = { stageReads: { missing: undefined } };
  for (let i = 0; i < 254; i++) node = { next: node };
  expect(() => copyCaptureEvidence({ executionTree: node }, 100000)).toThrow('too large');
});

it('uses one ordinal segment order even when one path is a prefix of another', () => {
  expect(
    validateAbsentEntries({
      executionTree: { stageReads: {} },
      absent: [
        ['executionTree', 'stageReads', 'missing'],
        ['executionTree', 'stageReads', 'missing', 'next'],
      ],
    }),
  ).toBe(false);
});
