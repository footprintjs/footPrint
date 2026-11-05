import type { JoinedRun } from '../readLawWitness.js';
import { checkedPair, equal, equalNativeTrace, refuse } from '../readLawWitness.js';
import { validateNativeWrites } from './nativeWrites.js';
import { appliedOperation } from './program.js';
import type {
  BranchPlan,
  BranchReceipt,
  Cause,
  CommitObservation,
  Context,
  FixtureCall,
  FixtureFamily,
} from './types.js';

function callOrder(calls: readonly FixtureCall[], branch: BranchReceipt) {
  let end = branch.operation.start;
  for (const call of calls) {
    if (
      call.start <= end ||
      call.end <= call.start ||
      call.end >= branch.operation.end ||
      call.frame !== branch.operation.frame ||
      call.outcome !== 'returned' ||
      !equal(call.operation, branch.operation.coordinate)
    )
      return refuse('wrong actual ordered fixture calls');
    end = call.end;
  }
}
function membership(run: JoinedRun, branch: BranchReceipt) {
  for (const call of branch.calls)
    if (run.native.events.find((event) => event.id === call.id) !== call)
      return refuse('call is not actual native receipt occurrence');
  const actual = run.native.events.filter(
    (event) =>
      event.tier === 'stage-call' && event.call !== undefined && equal(event.operation, branch.operation.coordinate),
  );
  if (
    !equal(
      actual.map(({ id }) => id),
      branch.calls.map(({ id }) => id),
    )
  )
    return refuse('unaccounted actual operation call');
}
function origin(context: Context, side: 'baseline' | 'build') {
  const run = side === 'baseline' ? context.a : context.b;
  const branch = context.cause[side];
  const get = context.reads[side === 'baseline' ? 0 : 1].get;
  const proof = side === 'baseline' ? context.cause.baselineCommit : context.cause.buildCommit;
  const row = run.commits[context.index];
  if (
    row.nativeId !== proof.id ||
    run.native.events.find((event) => event.id === proof.id) !== proof ||
    proof.tier !== 'buffer-call' ||
    proof.method !== 'commit' ||
    proof.outcome !== 'returned' ||
    proof.frame !== get.frame ||
    proof.buffer !== get.buffer ||
    proof.epoch !== get.epoch ||
    proof.start <= branch.operation.end ||
    proof.encoder.start <= proof.start ||
    proof.encoder.end >= proof.end ||
    proof.encoder.method !== (proof.encoder.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload') ||
    proof.encoder.bytes !== row.bytes
  )
    return refuse('missing or changed inner native encoder at FIRST commit');
}
function outside(run: JoinedRun, branch: BranchReceipt, commit: CommitObservation) {
  return {
    ...run.native,
    events: run.native.events.filter(
      (event) =>
        event.end < commit.start && !(event.start > branch.operation.start && event.end < branch.operation.end),
    ),
  };
}
/** All causes pass this boundary BEFORE a branch strategy can run. */
export function validateCommon(a: JoinedRun, b: JoinedRun, cause: Cause, family: FixtureFamily): Context {
  if (a.program !== b.program || a.native.leg !== b.native.leg) return refuse('different program/leg');
  if (b.commits.some((row) => !row.foldsBack)) return refuse('build commit does not fold back');
  const index = a.commits.findIndex((row, i) => row.bytes !== b.commits[i]?.bytes);
  if (index < 0 || !a.commits[index] || !b.commits[index]) return refuse('no joined FIRST differing commit');
  if (!a.commits[index].foldsBack) return refuse('first cause belongs to admitted-record-9.30, not #124');
  const reads = checkedPair(a.native, b.native, cause.pair);
  const old = cause.baseline;
  const now = cause.build;
  if (
    !equal(old.operation, cause.pair.baseline) ||
    !equal(now.operation, cause.pair.build) ||
    !equal(old.programPath, now.programPath) ||
    !equal(old.path, now.path)
  )
    return refuse('branch does not join proved operation');
  const context = { a, b, cause, family, index, reads, op: appliedOperation(a, cause, family) };
  callOrder(old.calls, old);
  callOrder(now.calls, now);
  membership(a, old);
  membership(b, now);
  origin(context, 'baseline');
  origin(context, 'build');
  return context;
}
/** Strategies cannot bypass physical writes, producer bytes or an independent prefix corruption. */
export function validateAfterStrategy(context: Context, plan: BranchPlan): void {
  validateNativeWrites(context, plan.baselineWrites, plan.buildWrites);
  // The operation itself was proved above: branch calls, physical producers, local identities,
  // canonical addresses and FIRST encoder. Outside it, the ONE comparator compares semantics;
  // actor placement is owned by the caller's existing firstDifference/R13 record view.
  if (
    !equalNativeTrace(
      outside(context.a, context.cause.baseline, context.cause.baselineCommit),
      outside(context.b, context.cause.build, context.cause.buildCommit),
      [],
    )
  )
    return refuse('independent call/prefix change before FIRST commit');
}
