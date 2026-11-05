/** Closed CHART branch-argument check ONLY; never a first-commit admission by itself. */
import { equal, refuse } from '../../readLawWitness.js';
import type { IdentityGraph, NativeFact, ValueFact } from '../../readWitness.js';
import type { BranchReceipt, FixtureCall } from '../types.js';

type Op = Readonly<{ t: string; k: string; k2?: string; p?: string; v?: unknown; i?: number }>;
type Write = {
  method: 'setObject' | 'updateObject';
  key: string;
  value: ValueFact;
  identity: 'same-read' | 'fresh' | 'none';
  embeddedRead?: { from: readonly string[]; to: readonly string[] };
  copiedRead?: readonly { from: readonly string[]; to: readonly string[] }[];
  literal?: { at: readonly string[]; value: ValueFact };
};
type Bound = { branch: BranchReceipt; read: NativeFact };
type Row = readonly [string, boolean, ValueFact];
const KEYS = ['a', 'b', 'list', 'obj', 'hist'];
const atom = (value: ValueFact) => ['undefined', 'null', 'string', 'number', 'boolean'].includes(value.kind);
const objectKind = (value: ValueFact) => ['object', 'array', 'date'].includes(value.kind);
const objectId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const undef = (): ValueFact => ({ kind: 'undefined' });

function rows(value: ValueFact): readonly Row[] {
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) return refuse('unsupported chart value entries');
  const seen = new Set<string>();
  return value.entries.map((item) => {
    if (
      !Array.isArray(item) ||
      item.length !== 3 ||
      typeof item[0] !== 'string' ||
      typeof item[1] !== 'boolean' ||
      !item[2] ||
      typeof item[2] !== 'object' ||
      seen.has(item[0])
    )
      return refuse('unsupported chart value entry');
    seen.add(item[0]);
    return item as unknown as Row;
  });
}

function supported(value: ValueFact, budget = { nodes: 0 }, depth = 0): void {
  if (++budget.nodes > 10_000 || depth > 64) return refuse('chart fact bound exceeded');
  if (value.kind === 'object' || value.kind === 'array') {
    for (const [, , child] of rows(value)) supported(child, budget, depth + 1);
  } else if (value.kind === 'date') {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return refuse('unsupported Date fact');
  } else if (value.kind === 'number') {
    if (typeof value.value !== 'string' || !Number.isFinite(Number(value.value)))
      return refuse('unsupported number fact');
  } else if (value.kind === 'string' || value.kind === 'boolean') {
    if (typeof value.value !== value.kind) return refuse('unsupported primitive fact');
  } else if (value.kind !== 'undefined' && value.kind !== 'null') return refuse('unsupported/ref chart fact');
}

/** Pure literal projection of unchanged materialise; never executes it on a native value. */
function literal(value: unknown, budget = { nodes: 0 }, depth = 0): ValueFact {
  if (++budget.nodes > 10_000 || depth > 64) return refuse('chart literal projection bound');
  if (value === '__DATE__') return { kind: 'date', value: 1_700_000_000_000 };
  if (value === undefined) return undef();
  if (value === null) return { kind: 'null' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return refuse('nonfinite chart literal');
    return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  }
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: typeof value, value };
  if (typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)))
    return refuse('unsupported chart literal');
  const array = Array.isArray(value);
  return {
    kind: array ? 'array' : 'object',
    ...(array ? { value: value.length } : {}),
    entries: Object.entries(value).map(([key, child]) => [key, true, literal(child, budget, depth + 1)]),
  };
}

function array(values: readonly ValueFact[]): ValueFact {
  return { kind: 'array', value: values.length, entries: values.map((value, i) => [String(i), true, value]) };
}
const record = (key: string, value: ValueFact): ValueFact => ({ kind: 'object', entries: [[key, true, value]] });
function literalWrite(write: Write, at: readonly string[], value: ValueFact): Write {
  return objectKind(value) ? { ...write, literal: { at, value } } : write;
}
function denseValues(value: ValueFact): ValueFact[] {
  if (value.kind !== 'array' || !Number.isSafeInteger(value.value) || (value.value as number) < 0)
    return refuse('unsupported array branch');
  const items = rows(value);
  if (
    items.length !== value.value ||
    items.some(
      ([key, enumerable, child], i) => key !== String(i) || !enumerable || (!atom(child) && !objectKind(child)),
    )
  )
    return refuse('sparse/unsupported array branch');
  return items.map(([, , child]) => child);
}

/** Reads only the existing immutable observer metadata, never native values or equal-content aliases. */
function identityRows(graph: IdentityGraph | undefined, root: number | undefined) {
  if (!Array.isArray(graph) || graph.length > 10_000 || !objectId(root))
    return refuse('embedded read identity graph/root is missing');
  const out = new Map<string, { path: readonly string[]; object: number }>();
  for (let i = 0; i < graph.length; i++) {
    const row = Object.getOwnPropertyDescriptor(graph, String(i))?.value;
    if (row === null || typeof row !== 'object') return refuse('unreadable embedded identity row');
    const path = Object.getOwnPropertyDescriptor(row, 'path')?.value;
    const object = Object.getOwnPropertyDescriptor(row, 'object')?.value;
    if (!Array.isArray(path) || path.length > 128 || !objectId(object))
      return refuse('unreadable embedded identity path/object');
    const parts: string[] = [];
    for (let j = 0; j < path.length; j++) {
      const part = Object.getOwnPropertyDescriptor(path, String(j))?.value;
      if (typeof part !== 'string') return refuse('non-data embedded identity segment');
      parts.push(part);
    }
    const key = JSON.stringify(parts);
    if (out.has(key)) return refuse('ambiguous embedded identity path');
    out.set(key, { path: parts, object });
  }
  if (out.get('[]')?.object !== root) return refuse('embedded identity graph has a different actual root');
  return [...out.values()];
}
function sameEmbeddedRead(read: NativeFact, call: FixtureCall, selection: NonNullable<Write['embeddedRead']>) {
  const prefix = (a: readonly string[], b: readonly string[]) =>
    a.length <= b.length && a.every((part, i) => part === b[i]);
  const old = identityRows(read.resultIdentities, read.resultObject).filter((row) => prefix(selection.from, row.path));
  const now = identityRows(call.call.identities?.[2], call.call.objects[2]).filter((row) =>
    prefix(selection.to, row.path),
  );
  if (
    !old.some((row) => equal(row.path, selection.from)) ||
    !now.some((row) => equal(row.path, selection.to)) ||
    old.length !== now.length
  )
    return refuse('embedded read subtree root is missing or changed');
  const actual = new Map(now.map((row) => [JSON.stringify(row.path), row.object]));
  for (const row of old) {
    const target = [...selection.to, ...row.path.slice(selection.from.length)];
    if (actual.get(JSON.stringify(target)) !== row.object)
      return refuse('embedded value does not preserve that SAME read object/subtree');
  }
}

/** The closed snapshot's object paths, not a native lookup, materialisation, or state replay. */
function objectPaths(value: ValueFact, path: readonly string[] = [], budget = { nodes: 0 }): readonly string[][] {
  if (++budget.nodes > 10_000 || path.length > 128) return refuse('literal identity shape bound exceeded');
  if (!objectKind(value)) return [];
  const out = [[...path]];
  if (value.kind === 'object' || value.kind === 'array')
    for (const [key, , child] of rows(value)) out.push(...objectPaths(child, [...path, key], budget));
  return out;
}
function completeIdentityRows(graph: IdentityGraph | undefined, value: ValueFact, root: number | undefined) {
  const expected = objectPaths(value);
  if (!expected.length) {
    if (root !== undefined || !Array.isArray(graph) || graph.length !== 0)
      return refuse('primitive read lacks its explicit empty identity graph');
    return [];
  }
  const actual = identityRows(graph, root);
  const keys = new Set(actual.map((row) => JSON.stringify(row.path)));
  if (actual.length !== expected.length || expected.some((path) => !keys.has(JSON.stringify(path))))
    return refuse('identity graph does not cover its complete observed value shape');
  return actual;
}
/** Closed fixture spread/batch copies every retained own member; the overwritten member is not copied. */
function copiedMembers(write: Write, read: ValueFact, overwritten?: string): Write {
  const nested = rows(read).filter(([, , value]) => objectKind(value));
  if (!nested.length) return write;
  return {
    ...write,
    copiedRead: nested.filter(([key]) => key !== overwritten).map(([key]) => ({ from: [key], to: [key] })),
  };
}
function sameCopiedMembers(read: NativeFact, call: FixtureCall, selections: NonNullable<Write['copiedRead']>) {
  const before = completeIdentityRows(read.resultIdentities, read.result!, read.resultObject);
  completeIdentityRows(call.call.identities?.[2], call.call.args[2], call.call.objects[2]);
  if (before.some((row) => row.object === call.call.objects[2]))
    return refuse('copied-member outer container aliases an original read object');
  for (const selection of selections) sameEmbeddedRead(read, call, selection);
}
function freshLiteral(read: NativeFact, call: FixtureCall, selected: NonNullable<Write['literal']>) {
  const before = completeIdentityRows(read.resultIdentities, read.result!, read.resultObject);
  const argument = completeIdentityRows(call.call.identities?.[2], call.call.args[2], call.call.objects[2]);
  const expected = objectPaths(selected.value).map((path) => [...selected.at, ...path]);
  const after = argument.filter(
    (row) => selected.at.length <= row.path.length && selected.at.every((part, i) => part === row.path[i]),
  );
  const ids = new Set(before.map((row) => row.object));
  const paths = new Set(after.map((row) => JSON.stringify(row.path)));
  if (
    !expected.length ||
    after.length !== expected.length ||
    expected.some((path) => !paths.has(JSON.stringify(path))) ||
    new Set(after.map((row) => row.object)).size !== after.length ||
    ids.has(call.call.objects[2]!) ||
    after.some((row) => ids.has(row.object))
  )
    return refuse('materialised literal/container has missing, aliased, or read-shared identity facts');
}

function project(op: Op, read: ValueFact): Write[] {
  const write = (
    value: ValueFact,
    identity: Write['identity'],
    key = op.k,
    method: Write['method'] = 'setObject',
  ): Write => ({ method, key, value, identity });
  const materialised = () => {
    const value = literal(op.v);
    return literalWrite(write(value, objectKind(value) ? 'fresh' : 'none'), [], value);
  };
  switch (op.t) {
    case 'same':
    case 'copy':
      return [write(read, objectKind(read) ? 'same-read' : 'none', op.t === 'copy' ? op.k2! : op.k)];
    case 'revert':
      return [materialised(), write(read, objectKind(read) ? 'same-read' : 'none')];
    case 'selfMerge':
      return ['object', 'array'].includes(read.kind) ? [write(read, 'same-read', op.k, 'updateObject')] : [];
    case 'spread': {
      if (read.kind !== 'object' && read.kind !== 'array') return [];
      const added = literal(op.v);
      if (read.kind === 'object') {
        const members = rows(read);
        if (members.some(([, enumerable]) => !enumerable)) return refuse('non-enumerable spread member');
        const next = members.map((row) => [...row] as [string, boolean, ValueFact]);
        const index = next.findIndex(([key]) => key === op.p);
        if (index < 0) next.push([op.p!, true, added]);
        else next[index][2] = added;
        return [
          literalWrite(copiedMembers(write({ kind: 'object', entries: next }, 'fresh'), read, op.p), [op.p!], added),
        ];
      }
      if (read.kind !== 'array') return [];
      const kept = denseValues(read);
      return [literalWrite(copiedMembers(write(array([...kept, added]), 'fresh'), read), [String(kept.length)], added)];
    }
    case 'mergeFirst': {
      if (read.kind === 'object')
        return [
          {
            ...write(record('y', read), 'fresh', op.k, 'updateObject'),
            embeddedRead: { from: [], to: ['y'] },
          },
        ];
      if (read.kind !== 'array' || read.value === 0) return [];
      const first = rows(read).find(([key]) => key === '0');
      if (!first || !first[1] || (!atom(first[2]) && !objectKind(first[2])))
        return refuse('mergeFirst selected value has no closed supported shape');
      return [
        {
          ...write(array([first[2]]), 'fresh', op.k, 'updateObject'),
          ...(objectKind(first[2]) && { embeddedRead: { from: ['0'], to: ['0'] } }),
        },
      ];
    }
    case 'batch': {
      const added = literal(op.v);
      const kept = read.kind === 'array' ? denseValues(read) : [];
      const result = write(array([...kept, added]), 'fresh');
      return [literalWrite(read.kind === 'array' ? copiedMembers(result, read) : result, [String(kept.length)], added)];
    }
    case 'setIn': {
      if (read.kind === 'object') return refuse('setIn proxy branch needs an actual exact native callshape');
      const added = literal(op.v);
      return [literalWrite(write(record(op.p!, added), 'fresh'), [op.p!], added)];
    }
    case 'push': {
      if (read.kind === 'array') return refuse('push proxy branch needs an actual exact native callshape');
      const added = literal(op.v);
      return [literalWrite(write(array([added]), 'fresh'), ['0'], added)];
    }
    case 'elem':
      if (read.kind === 'array' && rows(read).some(([key, , child]) => key === String(op.i) && child.kind === 'object'))
        return refuse('elem proxy/nested identity branch needs actual native evidence');
      return [];
    default:
      return refuse('unsupported ChartOp first-branch shape');
  }
}

function validateOp(op: Op) {
  const fields: Record<string, readonly string[]> = {
    copy: ['t', 'k', 'k2'],
    same: ['t', 'k'],
    revert: ['t', 'k', 'v'],
    selfMerge: ['t', 'k'],
    spread: ['t', 'k', 'p', 'v'],
    mergeFirst: ['t', 'k'],
    batch: ['t', 'k', 'v'],
    setIn: ['t', 'k', 'p', 'v'],
    push: ['t', 'k', 'v'],
    elem: ['t', 'k', 'i', 'p', 'v'],
  };
  if (
    !fields[op.t] ||
    !equal(Object.keys(op).sort(), [...fields[op.t]].sort()) ||
    !KEYS.includes(op.k) ||
    (op.t === 'copy' && !KEYS.includes(op.k2!)) ||
    (['spread', 'setIn', 'elem'].includes(op.t) && !['x', 'y', 'n'].includes(op.p!)) ||
    (op.t === 'elem' && (!Number.isSafeInteger(op.i) || op.i! < 0 || op.i! > 3))
  )
    return refuse('operation is not the closed applied CHART data shape');
}

function branch(op: Op, bound: Bound): { writes: readonly FixtureCall[]; declared: readonly Write[] } {
  const { branch: receipt, read } = bound;
  if (
    !objectId(read.id) ||
    !objectId(read.frame) ||
    receipt.operation.nativeId !== read.id ||
    receipt.operation.frame !== read.frame ||
    receipt.calls[0] !== read ||
    read.method !== 'getValue' ||
    read.outcome !== 'returned' ||
    !read.result ||
    receipt.path.length !== 0
  )
    return refuse('missing exact joined native CHART read');
  supported(read.result);
  const ids = new Set<number>();
  for (const call of receipt.calls) {
    if (
      !objectId(call.id) ||
      ids.has(call.id) ||
      call.frame !== read.frame ||
      call.outcome !== 'returned' ||
      !equal(call.operation, receipt.operation.coordinate) ||
      call.call.objects.length !== call.call.args.length
    )
      return refuse('missing or mismatched actual native call identity');
    ids.add(call.id);
    for (const [i, value] of call.call.args.entries()) {
      supported(value);
      if (objectKind(value) ? !objectId(call.call.objects[i]) : call.call.objects[i] !== undefined)
        return refuse('argument object identity is missing or inconsistent');
    }
  }
  if (!equal(receipt.calls[0].call.args, [literal([]), literal(op.k)])) return refuse('wrong actual read arguments');
  if (objectKind(read.result) ? !objectId(read.resultObject) : read.resultObject !== undefined)
    return refuse('returned value object identity missing or inconsistent');
  const declared = project(op, read.result);
  const writes = receipt.calls.slice(1);
  if (writes.length !== declared.length || receipt.edits.length !== 0)
    return refuse('unsupported exact CHART call/edit count');
  for (const [i, expected] of declared.entries()) {
    const call = writes[i];
    const args = [
      literal([]),
      literal(expected.key),
      expected.value,
      undef(),
      ...(expected.method === 'setObject' ? [undef()] : []),
    ];
    if (call.method !== expected.method || !equal(call.call.args, args))
      return refuse('write arguments differ from declared fixture branch');
    const id = call.call.objects[2];
    if (
      expected.identity === 'same-read'
        ? id !== read.resultObject
        : expected.identity === 'fresh'
        ? !objectId(id) || id === read.resultObject
        : id !== undefined
    )
      return refuse('write does not prove its declared SAME/fresh object relation');
    if (expected.embeddedRead) sameEmbeddedRead(read, call, expected.embeddedRead);
    if (expected.copiedRead) sameCopiedMembers(read, call, expected.copiedRead);
    if (expected.literal) freshLiteral(read, call, expected.literal);
  }
  return { writes, declared };
}

/** PRECONDITION: carrier already checked native receipt membership, read pair and actual program pointer.
 * This returns a declared branch check, NEVER a cause/admission. Carrier still checks exact native
 * order/staged producer/first encoder/prefix and unconditional laws on original records. */
export function chartBranchPair(op: Op, baseline: Bound, build: Bound) {
  try {
    validateOp(op);
    if (
      !equal(baseline.branch.operation.coordinate, build.branch.operation.coordinate) ||
      !equal(baseline.branch.programPath, build.branch.programPath) ||
      build.read.result?.kind !== 'undefined'
    )
      return refuse('branch does not join the same proved #124 operation');
    const old = branch(op, baseline);
    const now = branch(op, build);
    if (equal(old.declared, now.declared)) return refuse('no changed declared fixture write branch');
    return {
      kind: 'declared-chart-branches' as const,
      opcode: op.t,
      coordinate: baseline.branch.operation.coordinate,
      baselineWrites: old.writes,
      buildWrites: now.writes,
    };
  } catch (error) {
    return { kind: 'unproven' as const, reason: error instanceof Error ? error.message : 'unreadable CHART branch' };
  }
}
