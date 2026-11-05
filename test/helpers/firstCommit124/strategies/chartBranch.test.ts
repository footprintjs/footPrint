/** Inert shapes only. Actual membership/clock/encoder proof is carrier/root's separate gate. */
import { describe, expect, it } from 'vitest';

import { chartBranchPair } from './chartBranch.js';

const UNDEF = Symbol('fixture undefined');
const fact = (value: any): any =>
  value === UNDEF
    ? { kind: 'undefined' }
    : value === null
    ? { kind: 'null' }
    : typeof value !== 'object'
    ? { kind: typeof value, value: typeof value === 'number' ? String(value) : value }
    : {
        kind: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? { value: value.length } : {}),
        entries: Object.entries(value).map(([key, item]) => [key, true, fact(item)]),
      };
const coord = ['chart', 0, 'seed', 'invocation', 0, 'op', 1];
type Expected = { key?: string; value: any; id?: number; merge?: boolean };
function side(
  readValue: any,
  writes: Expected[],
  readId = 11,
  readObject = readValue !== UNDEF && readValue !== null && typeof readValue === 'object' ? 1 : undefined,
) {
  const read: any = {
    id: readId,
    start: 10,
    end: 12,
    leg: '0',
    method: 'getValue',
    outcome: 'returned',
    frame: 1,
    result: fact(readValue),
    resultObject: readObject,
    operation: coord,
    call: { args: [fact([]), fact('a')], objects: [50, undefined] },
  };
  const calls = [
    read,
    ...writes.map((write, i) => ({
      id: 20 + i,
      start: 20 + i * 2,
      end: 21 + i * 2,
      leg: '0',
      method: write.merge ? 'updateObject' : 'setObject',
      outcome: 'returned',
      frame: 1,
      operation: coord,
      call: {
        args: [
          fact([]),
          fact(write.key ?? 'a'),
          fact(write.value),
          fact(UNDEF),
          ...(!write.merge ? [fact(UNDEF)] : []),
        ],
        objects: [51 + i, undefined, write.id, undefined, ...(!write.merge ? [undefined] : [])],
      },
    })),
  ];
  return {
    read,
    branch: {
      operation: { coordinate: coord, frame: 1, start: 1, end: 99, nativeId: readId },
      programPath: ['seed', 1],
      path: [],
      calls,
      edits: [],
    },
  } as any;
}

describe('closed CHART branch argument shapes', () => {
  it.each([
    [{ t: 'spread', k: 'a', p: 'y', v: 3 }, { x: 2 }, [{ value: { x: 2, y: 3 }, id: 2 }], []],
    [{ t: 'spread', k: 'a', p: 'x', v: 3 }, [1, 2], [{ value: [1, 2, 3], id: 2 }], []],
    [{ t: 'copy', k: 'a', k2: 'b' }, { x: 1 }, [{ key: 'b', value: { x: 1 }, id: 1 }], [{ key: 'b', value: UNDEF }]],
    [{ t: 'same', k: 'a' }, { x: 1 }, [{ value: { x: 1 }, id: 1 }], [{ value: UNDEF }]],
    [
      { t: 'revert', k: 'a', v: 4 },
      { x: 1 },
      [{ value: 4 }, { value: { x: 1 }, id: 1 }],
      [{ value: 4 }, { value: UNDEF }],
    ],
    [{ t: 'selfMerge', k: 'a' }, { x: 1 }, [{ value: { x: 1 }, id: 1, merge: true }], []],
    [{ t: 'mergeFirst', k: 'a' }, [1, {}], [{ value: [1], id: 2, merge: true }], []],
    [{ t: 'batch', k: 'a', v: 2 }, [1], [{ value: [1, 2], id: 2 }], [{ value: [2], id: 1 }]],
  ] as const)('checks exact declared %j branches', (op, oldValue, oldWrites, newWrites) => {
    // Same numeric object IDs across engines are deliberately allowed: they are LOCAL namespaces.
    const result = chartBranchPair(op as any, side(oldValue, oldWrites as any), side(UNDEF, newWrites as any));
    expect(result.kind).toBe('declared-chart-branches');
    expect(result.kind).not.toBe('cause');
  });

  it('does not prove a same-opcode write containing an independent wrong value', () => {
    const result = chartBranchPair(
      { t: 'spread', k: 'a', p: 'y', v: 3 },
      side({ x: 2 }, [{ value: { x: 2, y: 99 }, id: 2 }]),
      side(UNDEF, []),
    );
    expect(result.kind).toBe('unproven');
  });

  it('refuses missing native ID even when all opcode/value bytes match', () => {
    const old = side({ x: 1 }, [{ value: { x: 1 }, id: 1 }]);
    old.read.id = undefined;
    expect(chartBranchPair({ t: 'same', k: 'a' }, old, side(UNDEF, [{ value: UNDEF }])).kind).toBe('unproven');
  });

  it('refuses equal contents on a DIFFERENT object for a SAME-read write', () => {
    expect(
      chartBranchPair(
        { t: 'copy', k: 'a', k2: 'b' },
        side({ x: 1 }, [{ key: 'b', value: { x: 1 }, id: 2 }]),
        side(UNDEF, [{ key: 'b', value: UNDEF }]),
      ).kind,
    ).toBe('unproven');
  });

  it('refuses a fresh spread that aliases its original returned object', () => {
    expect(
      chartBranchPair(
        { t: 'spread', k: 'a', p: 'y', v: 3 },
        side({ x: 2 }, [{ value: { x: 2, y: 3 }, id: 1 }]),
        side(UNDEF, []),
      ).kind,
    ).toBe('unproven');
  });

  it.each([
    [{ t: 'spread', k: 'a', p: 'x', v: 3 }, { y: {} }],
    [{ t: 'spread', k: 'a', p: 'x', v: {} }, { y: 1 }],
    [{ t: 'mergeFirst', k: 'a' }, { x: 1 }],
    [{ t: 'mergeFirst', k: 'a' }, [{}]],
    [{ t: 'batch', k: 'a', v: 2 }, [{}]],
    [{ t: 'setIn', k: 'a', p: 'x', v: 2 }, {}],
    [{ t: 'push', k: 'a', v: 2 }, [1]],
    [{ t: 'elem', k: 'a', i: 0, p: 'x', v: 2 }, [{}]],
  ] as const)('leaves unsupported nested/proxy %j proof closed', (op, value) => {
    expect(chartBranchPair(op as any, side(value, []), side(UNDEF, [])).kind).toBe('unproven');
  });

  it('rejects an extra unaccounted native call', () => {
    const old = side({ x: 2 }, [{ value: { x: 2, y: 3 }, id: 2 }]);
    old.branch.calls.push({ ...old.read, id: 77 });
    expect(chartBranchPair({ t: 'spread', k: 'a', p: 'y', v: 3 }, old, side(UNDEF, [])).kind).toBe('unproven');
  });

  it('does not claim a changed branch when batch outputs are actually identical', () => {
    expect(
      chartBranchPair(
        { t: 'batch', k: 'a', v: 2 },
        side([], [{ value: [2], id: 2 }]),
        side(UNDEF, [{ value: [2], id: 3 }]),
      ).kind,
    ).toBe('unproven');
  });
});
