/** Inert shapes only. Actual membership/clock/encoder proof is carrier/root's separate gate. */
import { describe, expect, it } from 'vitest';

import { chartBranchPair } from './chartBranch.js';

const UNDEF = Symbol('fixture undefined');
const fact = (value: any): any =>
  value === UNDEF
    ? { kind: 'undefined' }
    : value === null
    ? { kind: 'null' }
    : value instanceof Date
    ? { kind: 'date', value: value.getTime() }
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

/** Inert existing-port facts: these are not a native execution or FIRST-boundary approval. */
function embeddedMergeFirst(shape: 'object' | 'array') {
  const selected = { nested: { n: 1 } };
  const value = shape === 'object' ? selected : [selected, 2];
  const argument = shape === 'object' ? { y: value } : [selected];
  const old = side(value, [{ value: argument, id: 2, merge: true }]);
  old.read.resultIdentities =
    shape === 'object'
      ? [
          { path: [], object: 1 },
          { path: ['nested'], object: 3 },
        ]
      : [
          { path: [], object: 1 },
          { path: ['0'], object: 3 },
          { path: ['0', 'nested'], object: 4 },
        ];
  const graph =
    shape === 'object'
      ? [
          { path: [], object: 2 },
          { path: ['y'], object: 1 },
          { path: ['y', 'nested'], object: 3 },
        ]
      : [
          { path: [], object: 2 },
          { path: ['0'], object: 3 },
          { path: ['0', 'nested'], object: 4 },
        ];
  old.branch.calls[1].call.identities = [[{ path: [], object: 51 }], [], graph, []];
  return { op: { t: 'mergeFirst', k: 'a' } as const, old, now: side(UNDEF, []), graph };
}

describe.each(['object', 'array'] as const)('mergeFirst SAME embedded %s identity', (shape) => {
  it('uses the existing result/argument identity graphs for the exact whole copied subtree', () => {
    const f = embeddedMergeFirst(shape);
    expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('declared-chart-branches');
  });

  it(`refuses ${shape} matching descendants when BOTH selected-root entries are absent`, () => {
    const f = embeddedMergeFirst(shape);
    const selected = shape === 'object' ? [] : ['0'];
    f.old.read.resultIdentities = f.old.read.resultIdentities.filter(
      (row: { path: string[] }) => JSON.stringify(row.path) !== JSON.stringify(selected),
    );
    f.graph.splice(1, 1); // argument selected root; its matching descendant remains
    expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('unproven');
  });

  it.each([
    'no-read-graph',
    'no-argument-graph',
    'wrong-read-root',
    'wrong-argument-root',
    'equal-content-clone',
    'nested-equal-content-clone',
    'duplicate-path',
    'missing-descendant',
    'extra-descendant',
    'wrong-value',
    'wrong-key',
    'aliases-outer-with-read',
  ])(`still refuses ${shape} %s even when the opcode/coordinate/value surface otherwise matches`, (damage) => {
    const f = embeddedMergeFirst(shape);
    const write = f.old.branch.calls[1];
    if (damage === 'no-read-graph') f.old.read.resultIdentities = undefined;
    if (damage === 'no-argument-graph') write.call.identities = undefined;
    if (damage === 'wrong-read-root') f.old.read.resultIdentities[0].object = 99;
    if (damage === 'wrong-argument-root') f.graph[0].object = 99;
    if (damage === 'equal-content-clone') f.graph[1].object = 99;
    if (damage === 'nested-equal-content-clone') f.graph[2].object = 99;
    if (damage === 'duplicate-path') f.graph.push({ ...f.graph[1] });
    if (damage === 'missing-descendant') f.graph.pop();
    if (damage === 'extra-descendant') f.graph.push({ path: [...f.graph[1].path, 'unobserved'], object: 99 });
    if (damage === 'wrong-value')
      write.call.args[2] = fact(shape === 'object' ? { y: { nested: { n: 9 } } } : [{ nested: { n: 9 } }]);
    if (damage === 'wrong-key') write.call.args[1] = fact('b');
    if (damage === 'aliases-outer-with-read') {
      write.call.objects[2] = 1;
      f.graph[0].object = 1;
    }
    expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('unproven');
  });
});

type LiteralCase = 'spread-empty-object' | 'spread-object-nested' | 'batch-nested' | 'revert-nested' | 'spread-date';
type Graph = { path: string[]; object: number }[];
/** Inert existing-port metadata only; no native materialise/engine is invoked by this constructor. */
function materialisedLiteralCase(kind: LiteralCase) {
  const tree = { leaf: [{}] };
  const date = new Date(1_700_000_000_000);
  const op: any = kind === 'batch-nested' ? { t: 'batch', k: 'a', v: tree }
    : kind === 'revert-nested' ? { t: 'revert', k: 'a', v: tree }
    : { t: 'spread', k: 'a', p: 'y', v: kind === 'spread-empty-object' ? {} : kind === 'spread-date' ? '__DATE__' : tree };
  const readValue = kind === 'revert-nested' ? { read: {} } : kind === 'spread-object-nested' ? { x: 1 } : [1];
  const literal = kind === 'spread-empty-object' ? {} : kind === 'spread-date' ? date : tree;
  const oldArgument = kind === 'revert-nested' ? literal : kind === 'spread-object-nested' ? { x: 1, y: literal } : [1, literal];
  const oldWrites: Expected[] = [{ value: oldArgument, id: 2 }];
  const nowWrites: Expected[] = kind === 'batch-nested' ? [{ value: [literal], id: 2 }]
    : kind === 'revert-nested' ? [{ value: literal, id: 2 }, { value: UNDEF }] : [];
  if (kind === 'revert-nested') oldWrites.push({ value: readValue, id: 1 });
  const old = side(readValue, oldWrites);
  const now = side(UNDEF, nowWrites);
  const at = kind === 'revert-nested' ? [] : kind === 'spread-object-nested' ? ['y'] : ['1'];
  const graph: Graph = kind === 'revert-nested'
    ? [{ path: [], object: 2 }, { path: ['leaf'], object: 3 }, { path: ['leaf', '0'], object: 4 }]
    : [{ path: [], object: 2 }, { path: at, object: 3 },
      ...(kind === 'spread-empty-object' || kind === 'spread-date' ? []
        : [{ path: [...at, 'leaf'], object: 4 }, { path: [...at, 'leaf', '0'], object: 5 }])];
  old.read.resultIdentities = kind === 'revert-nested'
    ? [{ path: [], object: 1 }, { path: ['read'], object: 8 }] : [{ path: [], object: 1 }];
  now.read.resultIdentities = []; // actual primitive result: explicit empty, never a missing graph default
  const setGraph = (bound: any, index: number, rows: Graph) => {
    const call = bound.branch.calls[index];
    call.call.identities = call.call.args.map((_value: unknown, i: number) => i === 2 ? rows
      : i === 0 ? [{ path: [], object: call.call.objects[0] }] : []);
  };
  setGraph(old, 1, graph);
  if (kind === 'batch-nested') setGraph(now, 1, [
    { path: [], object: 2 }, { path: ['0'], object: 3 },
    { path: ['0', 'leaf'], object: 4 }, { path: ['0', 'leaf', '0'], object: 5 },
  ]);
  if (kind === 'revert-nested') setGraph(now, 1, graph.map((row) => ({ path: [...row.path], object: row.object })));
  return { op, old, now, graph, at };
}

describe('materialised literal subtrees use existing snapshot identity facts', () => {
  it.each(['spread-empty-object', 'spread-object-nested', 'batch-nested', 'revert-nested', 'spread-date'] as const)(
    'proves %s from exact semantic values and IDs disjoint from that read', (kind) => {
      const f = materialisedLiteralCase(kind);
      expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('declared-chart-branches');
    },
  );

  it.each(['missing-read-graph', 'wrong-read-root', 'missing-argument-graph', 'wrong-argument-root',
    'literal-aliases-read-root', 'literal-aliases-read-descendant', 'partial-read-graph-hides-alias',
    'missing-literal-descendant', 'extra-literal-descendant', 'duplicate-path', 'literal-self-alias', 'wrong-value'])(
    'refuses %s without treating equal content as fresh identity', (damage) => {
      const f = materialisedLiteralCase('revert-nested');
      const write = f.old.branch.calls[1];
      if (damage === 'missing-read-graph') f.old.read.resultIdentities = undefined;
      if (damage === 'wrong-read-root') f.old.read.resultIdentities[0].object = 99;
      if (damage === 'missing-argument-graph') write.call.identities = undefined;
      if (damage === 'wrong-argument-root') f.graph[0].object = 99;
      if (damage === 'literal-aliases-read-root') { write.call.objects[2] = 1; f.graph[0].object = 1; }
      if (damage === 'literal-aliases-read-descendant') f.graph[2].object = 8;
      if (damage === 'partial-read-graph-hides-alias') { f.graph[2].object = 8; f.old.read.resultIdentities.pop(); }
      if (damage === 'missing-literal-descendant') f.graph.pop();
      if (damage === 'extra-literal-descendant') f.graph.push({ path: ['unknown'], object: 99 });
      if (damage === 'duplicate-path') f.graph.push({ ...f.graph[1] });
      if (damage === 'literal-self-alias') f.graph[2].object = f.graph[1].object;
      if (damage === 'wrong-value') write.call.args[2] = fact({ leaf: [{ wrong: true }] });
      expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('unproven');
    },
  );

  it('requires the exact embedded literal root even if a different descendant keeps the row count equal', () => {
    const f = materialisedLiteralCase('spread-object-nested');
    f.graph.splice(1, 1);
    f.graph.push({ path: ['y', 'unobserved'], object: 99 });
    expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('unproven');
  });

  it('does not turn a missing primitive read graph into an empty graph by default', () => {
    const f = materialisedLiteralCase('batch-nested');
    f.now.read.resultIdentities = undefined;
    expect(chartBranchPair(f.op, f.old, f.now).kind).toBe('unproven');
  });
});
