import { expect, it } from 'vitest';

import { copyCaptureEvidence, validateAbsentEntries } from '../../../src/lib/capture/absentEntries.js';
import { copyHistoryData } from '../../../src/lib/capture/historyData.js';

const read = ['executionTree', '0', 'stageReads', 'missing'];
const evidence = () => ({ executionTree: [{ stageReads: { missing: undefined }, stageWrites: {} }] });
/** A stage `depth` branch levels down: each level is `branches / <b> / <i>` (three path segments). */
const nestedStage = (depth: number, stage: Record<string, unknown>) => {
  let node: Record<string, unknown> = stage;
  for (let i = 0; i < depth; i++) node = { branches: [[node]] };
  return node;
};

it('keeps no-sidecar JSON bytes unchanged, and ignores optional metadata and nested business omissions', () => {
  const data = { executionTree: [{ stageReads: { value: { missing: undefined, kept: 2 } } }], optional: undefined };
  expect(JSON.stringify(copyCaptureEvidence(data, 10000))).toBe(JSON.stringify(copyHistoryData(data, 10000)));
});

it('keeps literal keys and sorts first-stage, later-stage and branch paths by ordinal segments', () => {
  const writes = Object.defineProperty({ z: undefined, '1.stageReads.x': undefined, a: undefined }, '__proto__', {
    value: undefined,
    enumerable: true,
  });
  const value = {
    executionTree: [
      {
        stageReads: { missing: undefined },
        stageWrites: writes,
        branches: [[{ stageWrites: { missing: undefined } }]],
      },
      { stageReads: { missing: undefined } },
    ],
  };
  const copied = copyCaptureEvidence(value, 10000);
  expect(copied.absent).toEqual([
    ['executionTree', '0', 'branches', '0', '0', 'stageWrites', 'missing'],
    read,
    ['executionTree', '0', 'stageWrites', '1.stageReads.x'],
    ['executionTree', '0', 'stageWrites', '__proto__'],
    ['executionTree', '0', 'stageWrites', 'a'],
    ['executionTree', '0', 'stageWrites', 'z'],
    ['executionTree', '1', 'stageReads', 'missing'],
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
  [read, ['executionTree', '0', 'branches', '0', '0', 'stageReads', 'missing']],
  [['recorders', '0', 'stageReads', 'missing']],
  [['executionTree', '0', 'stageReads']],
  [['executionTree', '0', 'other', 'missing']],
  [['executionTree', '00', 'stageReads', 'missing']],
  [['executionTree', '0', 'branches', '00', '0', 'stageReads', 'missing']],
  [['executionTree', '0', 'branches', '999', '0', 'stageReads', 'missing']],
  [['executionTree', '1', 'stageReads', 'missing']],
  [['executionTree', 'stageReads', 'missing']],
  [['executionTree', 'next', 'stageReads', 'missing']],
  [['executionTree', '0', 'stageReads', 3]],
  Array(4097).fill(read),
  [['executionTree', '0', ...Array(85).fill(['branches', '0', '0']).flat(), 'stageReads', 'missing']],
])('refuses malformed, out-of-scope, duplicate or unsorted paths %#', (absent) => {
  expect(validateAbsentEntries(copyHistoryData({ executionTree: [{ stageReads: {} }], absent }, 1000000) as any)).toBe(
    false,
  );
});

it('refuses contradictory present-key, scalar-map and array-map markers', () => {
  for (const stageReads of [{ missing: 1 }, 1, [], { missing: null }])
    expect(validateAbsentEntries({ executionTree: [{ stageReads }], absent: [read] })).toBe(false);
});

it('bounds sidecar growth without dropping entries and charges UTF-8 and combined body bytes', () => {
  const stageReads = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [String(i), undefined]));
  expect(() => copyCaptureEvidence({ executionTree: [{ stageReads }] }, 1000000)).toThrow('too large');
  expect(() => copyCaptureEvidence(evidence(), 60)).toThrow('too large');
  expect(() =>
    copyCaptureEvidence({ executionTree: [{ stageReads: { ['🎈'.repeat(100)]: undefined } }] }, 200),
  ).toThrow('too large');
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
    expect(() => copyCaptureEvidence({ executionTree: [{ stageReads }] }, 10000)).toThrow();
  expect(calls).toBe(0);
});

it('refuses a retained event beyond the sidecar path-depth bound instead of silently omitting it', () => {
  // List form: a branch level is three path segments and three data levels, so the deepest stage the data
  // depth bound admits (84 levels) yields a 256-segment path, retained in full; one level deeper is refused
  // (by the data depth bound, which the list form now reaches first) — never silently omitted.
  const deepest = copyCaptureEvidence(
    { executionTree: [nestedStage(84, { stageReads: { missing: undefined } })] },
    1000000,
  );
  expect((deepest.absent as string[][]).map((path) => path.length)).toEqual([256]);
  expect(validateAbsentEntries(deepest)).toBe(true);
  expect(() =>
    copyCaptureEvidence({ executionTree: [nestedStage(85, { stageReads: { missing: undefined } })] }, 1000000),
  ).toThrow('Capture history data refused');
});

it('uses one ordinal segment order even when one path is a prefix of another', () => {
  expect(
    validateAbsentEntries({
      executionTree: [{ stageReads: {} }],
      absent: [
        ['executionTree', '0', 'stageReads', 'missing'],
        ['executionTree', '0', 'stageReads', 'missing', 'next'],
      ],
    }),
  ).toBe(false);
});
