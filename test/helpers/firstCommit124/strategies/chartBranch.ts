/** Closed CHART branch-argument check ONLY; never a first-commit admission by itself. */
import { equal, refuse } from '../../readLawWitness.js';
import type { ValueFact } from '../../readWitness.js';
import type { FixtureCall } from '../types.js';
import type { Bound, Op, Write } from './branchFacts.js';
import {
  array,
  atom,
  copiedMembers,
  denseValues,
  freshLiteral,
  KEYS,
  literal,
  literalWrite,
  objectId,
  objectKind,
  record,
  rows,
  sameCopiedMembers,
  sameEmbeddedRead,
  undef,
  validateCalls,
} from './branchFacts.js';
import { isProjectionOperation, projectionBranchPair } from './projection.js';

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
  validateCalls(op, bound);
  const declared = project(op, read.result!);
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
    if (isProjectionOperation(op.t)) return projectionBranchPair(op, baseline, build);
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
