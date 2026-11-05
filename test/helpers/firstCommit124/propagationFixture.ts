/** Scripted observation DATA for inert branch/boundary controls; never an engine or live proof. */
import type { JoinedRun, ReadPair } from '../readLawWitness.js';
import type { IdentityGraph, NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import type { BranchReceipt, Cause, CommitObservation, FixtureCall } from './types.js';

export const U: ValueFact = { kind: 'undefined' };
export const number = (n: number): ValueFact => ({ kind: 'number', value: String(n) });
export const record = (entries: Record<string, ValueFact>): ValueFact => ({
  kind: 'object',
  entries: Object.entries(entries).map(([name, value]) => [name, true, value]),
});
export const array = (...values: ValueFact[]): ValueFact => ({
  kind: 'array',
  value: values.length,
  entries: values.map((value, i) => [String(i), true, value]),
});
const text = (value: string): ValueFact => ({ kind: 'string', value });
const path = array();
export const graph = (id?: number, extra: IdentityGraph = []): IdentityGraph =>
  id === undefined ? [] : [{ path: [], object: id }, ...extra];

/** One argument-fed inert receipt. No lookup, mutation, merge or encoding algorithm is implemented. */
function side(build: boolean) {
  let clock = 0;
  const header = { stageId: 's', runtimeStageId: 's#0', runId: 'run' };
  const common = { leg: 'run', frame: 1, header, outcome: 'returned' as const };
  const events: NativeFact[] = [];
  const operations: OperationSpan[] = [];
  let span: OperationSpan;
  const roots = (id?: number, extra: IdentityGraph = []) => graph(id, extra);
  const start = (index: number, programPath: readonly (string | number)[] = ['stages', 0, index]) => {
    span = {
      coordinate: ['chart', 0, 'stage', 0, 'invocation', 0, 'op', index],
      programPath,
      path: [],
      start: ++clock,
      end: 0,
      outcome: 'returned',
      edits: [],
    };
    operations.push(span);
    return span;
  };
  const end = () => {
    Object.assign(span, { end: ++clock });
    return span;
  };
  const read = (key: string, value: ValueFact, id?: number, base?: ValueFact, extra: IdentityGraph = []) => {
    const began = ++clock;
    const heapStart = ++clock;
    const get: NativeFact = {
      ...common,
      id: ++clock,
      start: clock,
      end: ++clock,
      tier: 'buffer-call',
      method: 'get',
      phase: 'read',
      operation: span.coordinate,
      buffer: 1,
      epoch: 0,
      address: [key],
      result: base === undefined ? value : U,
      base: { found: base !== undefined, value: base ?? U },
    };
    const heapEnd = ++clock;
    const point = (at: number) => ({
      at,
      layout: build ? ('build-record-state' as const) : ('baseline-stage-shared-memory' as const),
      memory: 5000,
      generation: 5001,
      facts: record({}),
    });
    const call: FixtureCall = {
      ...common,
      id: began,
      start: began,
      end: ++clock,
      tier: 'stage-call',
      method: 'getValue',
      phase: 'read',
      operation: span.coordinate,
      gets: [get.id],
      result: value,
      resultObject: id,
      resultIdentities: roots(id, extra),
      ...(base === undefined ? { memoryGets: [], heapBefore: point(heapStart), heapAfter: point(heapEnd) } : {}),
      call: { args: [path, text(key)], objects: [1000 + began, undefined], identities: [roots(1000 + began), []] },
    };
    events.push(call, get);
    return { call, get };
  };
  const write = (key: string, value: ValueFact, id?: number, merge = false, extra: IdentityGraph = []) => {
    const began = ++clock;
    const native: NativeFact = {
      ...common,
      id: ++clock,
      start: clock,
      end: ++clock,
      tier: 'buffer-call',
      method: merge ? 'merge' : 'set',
      phase: 'write',
      operation: span.coordinate,
      buffer: 1,
      epoch: 0,
      address: [key],
      value,
      valueObject: id,
    };
    const tail = merge ? [U] : [U, U];
    const call: FixtureCall = {
      ...common,
      id: began,
      start: began,
      end: ++clock,
      tier: 'stage-call',
      method: merge ? 'updateObject' : 'setObject',
      phase: 'write',
      operation: span.coordinate,
      call: {
        args: [path, text(key), value, ...tail],
        objects: [1000 + began, undefined, id, ...tail.map(() => undefined)],
        identities: [graph(1000 + began), [], roots(id, extra), ...tail.map(() => [])],
      },
    };
    events.push(call, native);
    return { call, native };
  };
  const tomb = (key: string) => {
    const row: NativeFact = {
      ...common,
      id: ++clock,
      start: clock,
      end: ++clock,
      tier: 'buffer-call',
      method: 'delete',
      phase: 'write',
      buffer: 1,
      epoch: 0,
      address: [key],
    };
    events.push(row);
    return row;
  };
  const branch = (operation: OperationSpan, first: FixtureCall): BranchReceipt => ({
    operation: {
      coordinate: operation.coordinate,
      start: operation.start,
      end: operation.end,
      frame: 1,
      nativeId: first.id,
    },
    programPath: operation.programPath,
    path: [],
    edits: operation.edits,
    calls: events.filter((row) => row.tier === 'stage-call' && row.operation === operation.coordinate) as FixtureCall[],
  });
  const finish = (program: unknown, overwrite: unknown, updates: unknown = {}) => {
    const began = clock + 10;
    const commit: CommitObservation = {
      ...common,
      id: began,
      start: began,
      end: began + 4,
      tier: 'buffer-call',
      method: 'commit',
      phase: 'commit',
      buffer: 1,
      epoch: 0,
      encoder: {
        method: 'toChangeOnlyPayload',
        mode: 'full',
        start: began + 1,
        end: began + 2,
        bytes: JSON.stringify({ overwrite, updates, trace: [] }),
      },
    };
    events.push(commit);
    const run: JoinedRun = {
      program: JSON.stringify(program),
      native: { leg: 'run', events, issues: [] },
      operations,
      commits: [{ bytes: commit.encoder.bytes, foldsBack: true, nativeId: commit.id }],
      kept: {},
    };
    return { run, commit };
  };
  return { build, events, operations, start, end, read, write, tomb, branch, finish };
}
function join(
  a: ReturnType<typeof side>,
  b: ReturnType<typeof side>,
  primary: readonly [BranchReceipt, BranchReceipt],
  program: unknown,
  values: readonly [unknown, unknown],
) {
  const old = a.finish(program, values[0]);
  const now = b.finish(program, values[1]);
  const pair: ReadPair = { baseline: primary[0].operation, build: primary[1].operation, sites: [] };
  const cause: Cause = {
    pair,
    baseline: primary[0],
    build: primary[1],
    baselineCommit: old.commit,
    buildCommit: now.commit,
  };
  return { a: old.run, b: now.run, cause };
}
export function copyBatch() {
  const a = side(false);
  const b = side(true);
  const primary: BranchReceipt[] = [];
  const stale = array(number(7));
  for (const s of [a, b]) {
    s.tomb('list');
    const op = s.start(1);
    const read = s.read('list', s.build ? U : stale, s.build ? undefined : 7, stale);
    s.write('obj', s.build ? U : stale, s.build ? undefined : 7);
    s.end();
    primary.push(s.branch(op, read.call));
    s.start(2);
    s.read('obj', s.build ? U : stale, s.build ? undefined : 7);
    s.write('obj', s.build ? array(number(2)) : array(number(7), number(2)), s.build ? 11 : 10);
    s.end();
  }
  return join(
    a,
    b,
    primary as [BranchReceipt, BranchReceipt],
    {
      cfg: { commitValues: 'full' },
      stages: [
        [
          { t: 'del', k: 'list' },
          { t: 'copy', k: 'list', k2: 'obj' },
          { t: 'batch', k: 'obj', v: 2 },
        ],
      ],
    },
    [
      { list: '«undefined»', obj: [7, 2] },
      { list: '«undefined»', obj: [2] },
    ],
  );
}
export function mergeReadAll(tailMerge = false) {
  const a = side(false);
  const b = side(true);
  const primary: BranchReceipt[] = [];
  const stale = record({ n: number(1) });
  const output = record({ n: number(1) }); // Equal bytes do not assert input/output identity.
  for (const s of [a, b]) {
    s.tomb('obj');
    const op = s.start(1);
    const first = s.read('obj', s.build ? U : stale, s.build ? undefined : 7, stale);
    if (!s.build) s.write('obj', stale, 7, true);
    s.end();
    primary.push(s.branch(op, first.call));
    s.start(2);
    for (const key of ['a', 'b', 'list', 'obj', 'hist'])
      s.read(key, key === 'obj' && !s.build ? output : U, key === 'obj' && !s.build ? 8 : undefined);
    s.end();
    if (tailMerge) {
      s.start(3);
      s.read('obj', s.build ? U : output, s.build ? undefined : 8);
      if (!s.build) s.write('obj', output, 8, true);
      s.end();
    }
  }
  const ops: unknown[] = [{ t: 'del', k: 'obj' }, { t: 'selfMerge', k: 'obj' }, { t: 'readAll' }];
  if (tailMerge) ops.push({ t: 'selfMerge', k: 'obj' });
  return join(a, b, primary as [BranchReceipt, BranchReceipt], { cfg: { commitValues: 'full' }, stages: [ops] }, [
    { obj: { n: 1 } },
    { obj: '«undefined»' },
  ]);
}
export function preludeReadAll() {
  const a = side(false);
  const b = side(true);
  const primary: BranchReceipt[] = [];
  const stale = array(record({ n: number(1) }));
  for (const s of [a, b]) {
    s.tomb('hist');
    s.start(1);
    for (const key of ['a', 'b', 'list', 'obj', 'hist'])
      s.read(
        key,
        key === 'hist' && !s.build ? stale : U,
        key === 'hist' && !s.build ? 7 : undefined,
        key === 'hist' ? stale : undefined,
        key === 'hist' && !s.build ? [{ path: ['0'], object: 8 }] : [],
      );
    s.end();
    const op = s.start(2);
    const first = s.read(
      'hist',
      s.build ? U : stale,
      s.build ? undefined : 7,
      stale,
      !s.build ? [{ path: ['0'], object: 8 }] : [],
    );
    if (!s.build) s.write('hist', stale, 9, true, [{ path: ['0'], object: 8 }]);
    s.end();
    primary.push(s.branch(op, first.call));
  }
  return join(
    a,
    b,
    primary as [BranchReceipt, BranchReceipt],
    {
      cfg: { commitValues: 'full' },
      stages: [[{ t: 'del', k: 'hist' }, { t: 'readAll' }, { t: 'mergeFirst', k: 'hist' }]],
    },
    [{ hist: [{ n: 1 }] }, { hist: '«undefined»' }],
  );
}
