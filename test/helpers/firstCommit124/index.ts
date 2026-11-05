import {
  type JoinedRun,
  type Segment,
  checkedPair,
  equal,
  equalNativeTrace,
  refuse,
  Unproven124,
} from '../readLawWitness.js';
import type { NativeFact, ValueFact } from '../readWitness.js';
import { declaredWriteBackEdit } from './declaredEdit.js';
import type { BranchReceipt, Cause, CommitObservation, FirstCommitResult, FixtureCall } from './types.js';

const fact = (value: string | number | boolean | undefined | readonly string[]): ValueFact =>
  Array.isArray(value)
    ? {
        kind: 'array',
        value: value.length,
        entries: value.map((part, i) => [String(i), true, { kind: 'string', value: part }]),
      }
    : value === undefined
    ? { kind: 'undefined' }
    : { kind: typeof value, value: typeof value === 'number' ? String(value) : value };
const args = (...values: Parameters<typeof fact>[0][]) => values.map(fact);
const at = (value: unknown, path: readonly Segment[]): unknown => {
  for (const part of path) {
    if (value === null || typeof value !== 'object') return refuse('operation pointer is missing');
    const descriptor = Object.getOwnPropertyDescriptor(value, part);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return refuse('operation pointer is not own data');
    value = descriptor.value;
  }
  return value;
};
function operation(run: JoinedRun, receipt: BranchReceipt) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.program);
  } catch {
    return refuse('unreadable applied program bytes');
  }
  const op = at(parsed, receipt.programPath) as { t?: unknown; k?: unknown; n?: unknown; how?: unknown };
  if (
    !op ||
    op.t !== 'delReadBack' ||
    typeof op.k !== 'string' ||
    typeof op.n !== 'number' ||
    !Number.isFinite(op.n) ||
    (op.how !== 'set' && op.how !== 'merge')
  )
    return refuse('no closed delReadBack object/write branch');
  return op as { t: 'delReadBack'; k: string; n: number; how: 'set' | 'merge' };
}
function callOrder(calls: readonly FixtureCall[], bound: BranchReceipt) {
  let end = bound.operation.start;
  for (const call of calls) {
    if (
      call.start <= end ||
      call.end <= call.start ||
      call.end >= bound.operation.end ||
      call.frame !== bound.operation.frame ||
      call.outcome !== 'returned' ||
      !equal(call.operation, bound.operation.coordinate)
    )
      return refuse('wrong actual ordered fixture calls');
    end = call.end;
  }
}
function visibleCalls(run: JoinedRun, branch: BranchReceipt): void {
  for (const call of branch.calls) {
    // Identity is a receipt-local immutable occurrence; an independent supplied row is not enough.
    if (run.native.events.find((event) => event.id === call.id) !== call)
      return refuse('call is not the actual native receipt occurrence');
  }
  const actual = run.native.events.filter((event) => {
    const op = Object.getOwnPropertyDescriptor(event, 'operation')?.value;
    return Object.hasOwn(event, 'call') && equal(op, branch.operation.coordinate);
  });
  if (
    !equal(
      actual.map(({ id }) => id),
      branch.calls.map(({ id }) => id),
    )
  )
    return refuse('unaccounted actual call in bound operation');
}
function nativeWrite(
  run: JoinedRun,
  call: FixtureCall,
  method: 'delete' | 'set' | 'merge',
  address: readonly Segment[],
  buffer: number,
  epoch: number,
  object?: number,
) {
  const rows = run.native.events.filter(
    (e) => e.start > call.start && e.end < call.end && ['delete', 'set', 'merge'].includes(e.method),
  );
  if (
    rows.length !== 1 ||
    rows[0].method !== method ||
    rows[0].outcome !== 'returned' ||
    rows[0].phase !== 'write' ||
    rows[0].frame !== call.frame ||
    rows[0].buffer !== buffer ||
    rows[0].epoch !== epoch ||
    !equal(rows[0].address, address) ||
    (object !== undefined && Object.getOwnPropertyDescriptor(rows[0], 'valueObject')?.value !== object)
  )
    return refuse('actual staged write does not join declared branch');
}
function origin(run: JoinedRun, index: number, proof: CommitObservation, get: NativeFact, branch: BranchReceipt) {
  const commit = run.commits[index];
  if (
    !commit ||
    commit.nativeId !== proof.id ||
    run.native.events.find((e) => e.id === proof.id) !== proof ||
    proof.method !== 'commit' ||
    proof.outcome !== 'returned' ||
    proof.frame !== get.frame ||
    proof.buffer !== get.buffer ||
    proof.epoch !== get.epoch ||
    proof.start <= branch.operation.end ||
    proof.encoder.start <= proof.start ||
    proof.encoder.end >= proof.end ||
    proof.encoder.method !== (proof.encoder.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload') ||
    proof.encoder.bytes !== commit.bytes
  )
    return refuse('missing or changed native encoder output at first commit');
}
function outsideOperation(run: JoinedRun, branch: BranchReceipt, commit: CommitObservation) {
  return {
    ...run.native,
    events: run.native.events.filter(
      (event) =>
        event.end < commit.start && !(event.start > branch.operation.start && event.end < branch.operation.end),
    ),
  };
}

/** No causal replay: prove this ONE unchanged operation caused the FIRST changed commit, then stop. */
export function firstCommit124(a: JoinedRun, b: JoinedRun, cause: Cause): FirstCommitResult {
  try {
    if (a.program !== b.program || a.native.leg !== b.native.leg) return refuse('different program/leg');
    const encoding = (JSON.parse(a.program) as { commitValues?: unknown }).commitValues;
    if (
      (encoding !== 'full' && encoding !== 'delta') ||
      cause.baselineCommit.encoder.mode !== encoding ||
      cause.buildCommit.encoder.mode !== encoding
    )
      return refuse('encoder does not match this actual program mode');
    if (b.commits.some((row) => !row.foldsBack)) return refuse('build commit does not fold back');
    const index = a.commits.findIndex((row, i) => row.bytes !== b.commits[i]?.bytes);
    if (index < 0 || !a.commits[index] || !b.commits[index]) return refuse('no joined FIRST differing commit');
    if (!a.commits[index].foldsBack) return refuse('first cause belongs to admitted-record-9.30, not #124');
    const [x, y] = checkedPair(a.native, b.native, cause.pair);
    const old = cause.baseline;
    const now = cause.build;
    if (
      !equal(old.operation, cause.pair.baseline) ||
      !equal(now.operation, cause.pair.build) ||
      !equal(old.programPath, now.programPath) ||
      !equal(old.path, now.path)
    )
      return refuse('branch receipt does not join proved operation');
    const op = operation(a, old);
    const other = operation(b, now);
    if (!equal(op, other)) return refuse('different applied fixture operation');
    callOrder(old.calls, old);
    callOrder(now.calls, now);
    visibleCalls(a, old);
    visibleCalls(b, now);
    if (old.calls.length !== 3 || now.calls.length !== 2 || old.edits.length !== 1 || now.edits.length !== 1)
      return refuse('old/new branch did not make exact declared call/edit count');
    const [delA, readA, writeA] = old.calls;
    const [delB, readB] = now.calls;
    const deletion = args(old.path, op.k, undefined, false, undefined, 'delete');
    const reading = args(old.path, op.k);
    if (
      delA.method !== 'setObject' ||
      delB.method !== 'setObject' ||
      !equal(delA.call.args, deletion) ||
      !equal(delB.call.args, deletion) ||
      readA.id !== x.read.id ||
      readB.id !== y.read.id ||
      !equal(readA.call.args, reading) ||
      !equal(readB.call.args, reading) ||
      writeA.method !== (op.how === 'set' ? 'setObject' : 'updateObject') ||
      writeA.call.args.length !== 3 ||
      !equal(writeA.call.args.slice(0, 2), reading)
    )
      return refuse('actual call arguments differ from declared branch');
    const edit = old.edits[0];
    if (
      edit.outcome !== 'returned' ||
      x.read.resultObject === undefined ||
      edit.object !== x.read.resultObject ||
      edit.n !== op.n ||
      !(readA.end < edit.start && edit.start < edit.end && edit.end < writeA.start) ||
      writeA.call.objects[2] !== edit.object ||
      !equal(edit.before, x.read.result) ||
      !equal(edit.after, writeA.call.args[2])
    )
      return refuse('edit/write does not use that SAME returned object');
    declaredWriteBackEdit(edit.before, op.n, edit.after);
    const skipped = now.edits[0];
    if (
      skipped.outcome !== 'returned' ||
      skipped.object !== undefined ||
      skipped.n !== op.n ||
      skipped.before.kind !== 'undefined' ||
      skipped.after.kind !== 'undefined' ||
      !(readB.end < skipped.start && skipped.start < skipped.end && skipped.end < now.operation.end)
    )
      return refuse('build did not execute the unchanged no-object edit branch');
    nativeWrite(a, delA, 'delete', x.get.address!, x.get.buffer!, x.get.epoch!);
    nativeWrite(b, delB, 'delete', y.get.address!, y.get.buffer!, y.get.epoch!);
    nativeWrite(a, writeA, op.how, x.get.address!, x.get.buffer!, x.get.epoch!, edit.object);
    origin(a, index, cause.baselineCommit, x.get, old);
    origin(b, index, cause.buildCommit, y.get, now);
    if (
      !equalNativeTrace(outsideOperation(a, old, cause.baselineCommit), outsideOperation(b, now, cause.buildCommit), [])
    )
      return refuse('independent call/prefix change before first commit');
    return { kind: 'cause', name: 'read-after-delete-124', commit: index, coordinate: old.operation.coordinate };
  } catch (error) {
    return {
      kind: 'unproven',
      reason: error instanceof Unproven124 ? error.message : 'unreadable operation/encoder proof',
    };
  }
}
