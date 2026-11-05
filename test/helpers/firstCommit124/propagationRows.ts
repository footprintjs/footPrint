/** Original operation/native membership only. No state, merge, or causal replay. */
import type { JoinedRun } from '../readLawWitness.js';
import { equal, refuse } from '../readLawWitness.js';
import type { NativeFact, OperationSpan } from '../readWitness.js';
import { memoryCallsOf } from '../readWitness.js';
import { prefix, validateNativeWriteSide } from './nativeWrites.js';
import { callOrder, membership } from './operationCalls.js';
import { appliedOperation } from './program.js';
import type { BranchReceipt, Context, FixtureCall } from './types.js';

export const overlaps = (a: readonly (string | number)[], b: readonly (string | number)[]) => {
  const prefix = (x: typeof a, y: typeof b) =>
    x.length <= y.length && x.every((part, i) => String(part) === String(y[i]));
  return prefix(a, b) || prefix(b, a);
};
export function occurrence(run: JoinedRun, row: NativeFact): void {
  if (
    run.native.events.filter((actual) => actual === row).length !== 1 ||
    run.native.events.filter((actual) => actual.id === row.id).length !== 1 ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    !(row.start < row.end) ||
    row.leg !== run.native.leg ||
    row.outcome !== 'returned'
  )
    return refuse('propagation has no unique original returned occurrence');
}
export function branchAt(context: Context, side: 'baseline' | 'build', span: OperationSpan): BranchReceipt {
  const run = side === 'baseline' ? context.a : context.b;
  const owner = context.reads[side === 'baseline' ? 0 : 1].read;
  const commit = context.cause[side === 'baseline' ? 'baselineCommit' : 'buildCommit'];
  if (
    run.operations?.filter((actual) => actual === span).length !== 1 ||
    span.outcome !== 'returned' ||
    !span.path ||
    span.path.some((part) => typeof part !== 'string') ||
    span.edits.length ||
    span.end >= commit.start
  )
    return refuse('propagation operation is not an original pre-FIRST span');
  const calls = run.native.events.filter((row) => row.tier === 'stage-call' && equal(row.operation, span.coordinate));
  if (!calls.length || calls.some((row) => !row.call || row.frame !== owner.frame || !equal(row.header, owner.header)))
    return refuse('propagation operation has another stage owner or missing calls');
  const branch: BranchReceipt = {
    operation: {
      coordinate: span.coordinate,
      frame: owner.frame!,
      start: span.start,
      end: span.end,
      nativeId: calls[0].id,
    },
    programPath: span.programPath,
    path: span.path,
    calls: calls as FixtureCall[],
    edits: span.edits,
  };
  callOrder(branch.calls, branch);
  membership(run, branch);
  for (const call of calls) occurrence(run, call);
  return branch;
}
export function pairedSpan(context: Context, old: OperationSpan): OperationSpan {
  const matches = context.b.operations?.filter(
    (span) => equal(span.coordinate, old.coordinate) && equal(span.programPath, old.programPath),
  );
  if (matches?.length !== 1) return refuse('propagation lacks the one corresponding build span');
  return matches[0];
}
export function operation(context: Context, old: BranchReceipt, now: BranchReceipt) {
  return appliedOperation(context.a, { ...context.cause, baseline: old, build: now }, 'chart');
}
export function getOf(context: Context, side: 'baseline' | 'build', read: FixtureCall, selected = false): NativeFact {
  const run = side === 'baseline' ? context.a : context.b;
  const primary = context.reads[side === 'baseline' ? 0 : 1];
  if (read.method !== 'getValue' || read.phase !== 'read' || !read.result || read.gets?.length !== 1)
    return refuse('propagation lacks its original tracked read/get');
  const get = run.native.events.find((row) => row.id === read.gets![0]);
  if (!get) return refuse('propagation native get is missing');
  occurrence(run, get);
  if (
    get.tier !== 'buffer-call' ||
    get.method !== 'get' ||
    get.phase !== 'read' ||
    !(read.start < get.start && get.end < read.end) ||
    get.frame !== read.frame ||
    !equal(get.header, read.header) ||
    !equal(get.operation, read.operation) ||
    get.buffer !== primary.get.buffer ||
    get.epoch !== primary.get.epoch ||
    !get.address
  )
    return refuse('propagation get has another original frame/buffer/epoch/address owner');
  prefix(read, get); // The SAME existing observed canonical/user-suffix join, no second address policy.
  const memory = read.memoryGets === undefined ? [] : memoryCallsOf(run.native, read);
  if (
    memory.length
      ? memory.length !== 1 || memory[0].resultObject !== read.resultObject || !equal(memory[0].result, read.result)
      : !equal(get.result, read.result)
  )
    return refuse('propagation delivery is not the original get/fallback return');
  if (selected && memory.length) {
    // The only admitted selected fallback is the original baseline SharedMemory signature.
    // Unselected readAll rows stay with the existing semantic comparator, including their own calls.
    const call = memory[0];
    if (
      side !== 'baseline' ||
      call.call?.args.length !== 3 ||
      !equal(call.call.args[0], { kind: 'string', value: read.header?.runId }) ||
      !equal(call.call.args.slice(1), read.call.args) ||
      call.call.objects[1] !== read.call.objects[0] ||
      !Number.isSafeInteger(call.call.objects[1]) ||
      !(get.end < call.start)
    )
      return refuse('propagation fallback does not join the original run/path/key/identity');
  }
  return get;
}
export function readRows(run: JoinedRun, read: FixtureCall, get: NativeFact): readonly NativeFact[] {
  return [read, get, ...(read.memoryGets === undefined ? [] : memoryCallsOf(run.native, read))];
}
export function producers(
  context: Context,
  side: 'baseline' | 'build',
  branch: BranchReceipt,
  read: FixtureCall,
  get: NativeFact,
  writes: readonly FixtureCall[],
): readonly NativeFact[] {
  const run = side === 'baseline' ? context.a : context.b;
  validateNativeWriteSide(run, branch, read, get, writes);
  return writes.map((write) => {
    const row = run.native.events.find(
      (actual) =>
        actual.tier === 'buffer-call' &&
        actual.phase === 'write' &&
        write.start < actual.start &&
        actual.end < write.end,
    )!;
    occurrence(run, row);
    if (!equal(row.header, read.header) || !equal(row.operation, branch.operation.coordinate))
      return refuse('propagation physical producer has another original operation owner');
    return row;
  });
}
export function wholeRows(run: JoinedRun, branch: BranchReceipt, owned: readonly NativeFact[]) {
  const set = new Set(owned);
  const actual = run.native.events.filter(
    (row) => branch.operation.start < row.start && row.end < branch.operation.end,
  );
  if (set.size !== owned.length || actual.length !== set.size || actual.some((row) => !set.has(row)))
    return refuse('unaccounted row inside proved propagation operation');
  for (const row of set) {
    occurrence(run, row);
    if (
      !equal(row.operation, branch.operation.coordinate) ||
      row.frame !== branch.operation.frame ||
      !equal(row.header, branch.calls[0].header)
    )
      return refuse('propagation row has another operation/frame owner');
  }
  return set;
}
export function noIntervening(
  run: JoinedRun,
  producer: NativeFact,
  read: NativeFact,
  address: readonly (string | number)[],
) {
  occurrence(run, producer);
  if (
    producer.tier !== 'buffer-call' ||
    producer.phase !== 'write' ||
    !['set', 'merge', 'delete'].includes(producer.method) ||
    !equal(producer.address, address) ||
    producer.frame !== read.frame ||
    !equal(producer.header, read.header) ||
    !(producer.end < read.start) ||
    run.native.events.some(
      (row) =>
        row !== producer &&
        row.tier === 'buffer-call' &&
        row.buffer === producer.buffer &&
        row.epoch === producer.epoch &&
        row.phase === 'write' &&
        row.address &&
        row.end > producer.end &&
        row.start < read.end &&
        overlaps(row.address, address),
    )
  )
    return refuse('intervening original producer re-established propagation address');
}
