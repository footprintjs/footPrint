import type { ContinuationFact } from '../nativeTraceFacts.js';
import type { JoinedRun } from '../readLawWitness.js';
import { equal, refuse } from '../readLawWitness.js';
import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { memoryCallsOf, validateHeapLinks } from '../readWitness.js';
import { validateNativeWriteSide } from './nativeWrites.js';
import { callOrder, membership } from './operationCalls.js';
import { appliedOperation, own } from './program.js';
import { declaredWriteBackEdit } from './strategies/declaredEdit.js';
import type { BranchPlan, BranchReceipt, Context, FixtureCall } from './types.js';
import { args } from './valueFacts.js';

export interface Continuations {
  readonly baseline: ReadonlySet<NativeFact>;
  readonly build: ReadonlySet<NativeFact>;
  readonly facts: readonly ContinuationFact[];
}
const positive = (id: number | undefined): id is number => Number.isSafeInteger(id) && id! > 0;
const sameStagePointer = (a: readonly (string | number)[], b: readonly (string | number)[]) =>
  a.length === 4 &&
  b.length === 4 &&
  a[0] === 'stages' &&
  a[2] === 'ops' &&
  Number.isSafeInteger(a[1]) &&
  Number.isSafeInteger(a[3]) &&
  Number.isSafeInteger(b[3]) &&
  equal(a.slice(0, 3), b.slice(0, 3)) &&
  (b[3] as number) > (a[3] as number);
const rootIdentity = (graph: readonly { path: readonly string[]; object: number }[] | undefined, id: number) => {
  const roots = graph?.filter((entry) => entry.path.length === 0);
  return positive(id) && roots?.length === 1 && roots[0].object === id;
};

function occurrence(run: JoinedRun, row: NativeFact): void {
  if (
    run.native.events.filter((actual) => actual === row).length !== 1 ||
    run.native.events.filter((actual) => actual.id === row.id).length !== 1 ||
    !positive(row.id) ||
    row.leg !== run.native.leg ||
    row.outcome !== 'returned'
  )
    return refuse('continuation is not one original returned native occurrence');
}
function branch(run: JoinedRun, span: OperationSpan, frame: number, header: NativeFact['header']): BranchReceipt {
  if (
    run.operations?.filter((actual) => actual === span).length !== 1 ||
    span.outcome !== 'returned' ||
    !span.path ||
    span.path.some((part) => typeof part !== 'string')
  )
    return refuse('continuation has no unique original operation span');
  const calls = run.native.events.filter((row) => row.tier === 'stage-call' && equal(row.operation, span.coordinate));
  const read = calls[0];
  if (!read || calls.some((row) => !row.call || row.frame !== frame || !equal(row.header, header)))
    return refuse('continuation belongs to another actual stage or has missing call facts');
  const result: BranchReceipt = {
    operation: { coordinate: span.coordinate, start: span.start, end: span.end, frame, nativeId: read.id },
    programPath: span.programPath,
    path: span.path,
    calls: calls as readonly FixtureCall[],
    edits: span.edits,
  };
  callOrder(result.calls, result);
  membership(run, result);
  for (const call of calls) occurrence(run, call);
  return result;
}
function getOf(run: JoinedRun, read: FixtureCall, primary: Context['reads'][number]): NativeFact {
  if (read.gets?.length !== 1) return refuse('continuation read has no single original native get');
  const get = run.native.events.find((row) => row.id === read.gets![0]);
  if (!get) return refuse('continuation native get is missing');
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
    !equal(get.address, primary.get.address)
  )
    return refuse('continuation does not read the SAME canonical frame/buffer/epoch/address');
  return get;
}
function exactRows(run: JoinedRun, span: OperationSpan, owned: readonly NativeFact[]): ReadonlySet<NativeFact> {
  const result = new Set(owned);
  if (result.size !== owned.length) return refuse('continuation row claimed twice');
  const actual = run.native.events.filter((row) => span.start < row.start && row.end < span.end);
  if (actual.length !== result.size || actual.some((row) => !result.has(row)))
    return refuse('unaccounted native observation inside continuation');
  for (const row of owned) {
    occurrence(run, row);
    if (!equal(row.operation, span.coordinate)) return refuse('continuation row has another operation owner');
  }
  return result;
}
const memory = (run: JoinedRun, read: NativeFact) =>
  read.memoryGets === undefined ? [] : memoryCallsOf(run.native, read);

/** One closed unchanged WRITEBACK readBack branch. No branch/prefix grant is inferred from an opcode alone. */
function prove(
  context: Context,
  oldSpan: OperationSpan,
  nowSpan: OperationSpan,
  sameObject: number,
  before: ValueFact,
) {
  const [x, y] = context.reads;
  const old = branch(context.a, oldSpan, x.read.frame!, x.read.header);
  const now = branch(context.b, nowSpan, y.read.frame!, y.read.header);
  if (
    !equal(old.operation.coordinate, now.operation.coordinate) ||
    !equal(old.programPath, now.programPath) ||
    !equal(old.path, context.cause.baseline.path) ||
    !equal(now.path, context.cause.build.path) ||
    !sameStagePointer(context.cause.baseline.programPath, old.programPath) ||
    !sameStagePointer(context.cause.build.programPath, now.programPath)
  )
    return refuse('continuation does not name the SAME later unchanged fixture operation');
  const op = appliedOperation(context.a, { ...context.cause, baseline: old, build: now }, 'writeback');
  if (
    op.t !== 'readBack' ||
    typeof op.k !== 'string' ||
    op.k !== context.op.k ||
    typeof op.n !== 'number' ||
    !Number.isFinite(op.n) ||
    (op.how !== 'set' && op.how !== 'merge') ||
    old.calls.length !== 2 ||
    now.calls.length !== 1 ||
    old.edits.length !== 1 ||
    now.edits.length !== 1
  )
    return refuse('no closed SAME-object readBack continuation');
  const [read, write] = old.calls;
  const next = now.calls[0];
  const reading = args(old.path, op.k);
  if (
    read.method !== 'getValue' ||
    next.method !== 'getValue' ||
    read.phase !== 'read' ||
    next.phase !== 'read' ||
    !equal(read.call.args, reading) ||
    !equal(next.call.args, reading) ||
    !read.result ||
    !['array', 'object', 'date'].includes(read.result.kind) ||
    !equal(read.result, before) ||
    read.resultObject !== sameObject ||
    !rootIdentity(read.resultIdentities, sameObject) ||
    next.result?.kind !== 'undefined' ||
    next.resultObject !== undefined ||
    write.method !== (op.how === 'set' ? 'setObject' : 'updateObject') ||
    write.phase !== 'write' ||
    write.call.args.length !== 3 ||
    !equal(write.call.args.slice(0, 2), reading) ||
    write.call.objects[2] !== sameObject ||
    !rootIdentity(write.call.identities?.[2], sameObject)
  )
    return refuse('continuation read/write is not the original SAME object versus undefined/no-write');
  const edit = old.edits[0];
  const skipped = now.edits[0];
  if (
    edit.outcome !== 'returned' ||
    edit.object !== sameObject ||
    edit.n !== op.n ||
    !(read.end < edit.start && edit.start < edit.end && edit.end < write.start) ||
    !equal(edit.before, read.result) ||
    !equal(edit.after, write.call.args[2]) ||
    skipped.outcome !== 'returned' ||
    skipped.object !== undefined ||
    skipped.n !== op.n ||
    skipped.before.kind !== 'undefined' ||
    skipped.after.kind !== 'undefined' ||
    !(next.end < skipped.start && skipped.start < skipped.end && skipped.end < now.operation.end)
  )
    return refuse('continuation has missing/different original edit facts');
  declaredWriteBackEdit(edit.before, op.n, edit.after);
  const oldGet = getOf(context.a, read, x);
  const newGet = getOf(context.b, next, y);
  if (!equal(oldGet.result, read.result))
    return refuse('baseline continuation native get differs from SAME-object read');
  if (newGet.result?.kind !== 'undefined') return refuse('build continuation has no actual undefined native get');
  validateNativeWriteSide(context.a, old, read, oldGet, [write]);
  validateNativeWriteSide(context.b, now, next, newGet, []);
  const writes = context.a.native.events.filter(
    (row) => row.tier === 'buffer-call' && row.phase === 'write' && write.start < row.start && row.end < write.end,
  );
  // validateNativeWriteSide established exactly one physical producer; do not synthesize another receipt.
  return {
    oldRows: exactRows(context.a, oldSpan, [read, oldGet, ...memory(context.a, read), write, ...writes]),
    newRows: exactRows(context.b, nowSpan, [next, newGet, ...memory(context.b, next)]),
    after: edit.after,
    fact: {
      operation: old.operation.coordinate,
      address: oldGet.address!,
      baselineObjectId: sameObject,
      buildRead: { kind: 'undefined' as const },
      write: false as const,
    },
  };
}

/** Original row references ONLY, produced after the original primary branch has already passed its strategy. */
export function proveContinuations(context: Context, plan: BranchPlan): Continuations {
  const baseline = new Set<NativeFact>();
  const build = new Set<NativeFact>();
  const facts: ContinuationFact[] = [];
  if (context.family !== 'writeback' || context.op.t !== 'delReadBack') return { baseline, build, facts };
  const oldOps = context.a.operations;
  const newOps = context.b.operations;
  if (!oldOps && !newOps) return { baseline, build, facts }; // Legacy inert primary-only inputs.
  if (!oldOps || !newOps) return refuse('continuation operation observation is missing on one side');
  const object = context.reads[0].read.resultObject;
  const write = plan.baselineWrites.at(-1);
  if (!positive(object) || !write || write.call.objects[2] !== object)
    return refuse('proved primary branch has no SAME-object continuation anchor');
  let value = write.call.args[2];
  let oldEnd = context.cause.baseline.operation.end;
  let newEnd = context.cause.build.operation.end;
  for (const span of oldOps) {
    if (
      span.start <= context.cause.baseline.operation.end ||
      span.end >= context.cause.baselineCommit.start ||
      !sameStagePointer(context.cause.baseline.programPath, span.programPath)
    )
      continue;
    let op: unknown = JSON.parse(context.a.program); // Same immutable bytes already admitted by common/program.
    for (const part of span.programPath) op = own(op, part);
    if (own(op, 't') !== 'readBack' || own(op, 'k') !== context.op.k || !equal(span.path, context.cause.baseline.path))
      continue;
    const matches = newOps.filter(
      (row) => equal(row.coordinate, span.coordinate) && equal(row.programPath, span.programPath),
    );
    if (matches.length !== 1) return refuse('continuation has no unique actual build operation');
    const next = matches[0];
    if (
      !(
        oldEnd < span.start &&
        span.start < span.end &&
        newEnd < next.start &&
        next.start < next.end &&
        next.end < context.cause.buildCommit.start
      )
    )
      return refuse('continuation order crossed its FIRST stage commit');
    const proved = prove(context, span, next, object, value);
    for (const row of proved.oldRows) {
      if (baseline.has(row)) return refuse('baseline continuation occurrence claimed twice');
      baseline.add(row);
    }
    for (const row of proved.newRows) {
      if (build.has(row)) return refuse('build continuation occurrence claimed twice');
      build.add(row);
    }
    facts.push(proved.fact);
    value = proved.after;
    oldEnd = span.end;
    newEnd = next.end;
  }
  // Validate ORIGINAL receipts before common.ts cuts their already proved operation rows.
  validateHeapLinks(context.a.native);
  validateHeapLinks(context.b.native);
  return { baseline, build, facts };
}
