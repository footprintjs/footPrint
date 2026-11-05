import type { ContinuationFact, PropagationFact, RetainedReadWindow } from '../nativeTraceFacts.js';
import type { JoinedRun } from '../readLawWitness.js';
import { checkedPair, equal, equalNativeTrace, priorRetainedWindows, refuse } from '../readLawWitness.js';
import type { NativeFact } from '../readWitness.js';
import { proveContinuations } from './continuation.js';
import { validateNativeWrites } from './nativeWrites.js';
import { callOrder, membership } from './operationCalls.js';
import { appliedOperation } from './program.js';
import { proveChartPropagation } from './propagation.js';
import type { BranchPlan, BranchReceipt, Cause, CommitObservation, Context, FixtureFamily } from './types.js';

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
function outside(
  run: JoinedRun,
  branch: BranchReceipt,
  commit: CommitObservation,
  continuation: ReadonlySet<NativeFact>,
) {
  return {
    ...run.native,
    events: run.native.events.filter(
      (event) =>
        event.end < commit.start &&
        !(event.start > branch.operation.start && event.end < branch.operation.end) &&
        !continuation.has(event),
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
export interface AfterStrategy {
  readonly retainedReadWindows: readonly RetainedReadWindow[];
  readonly priorPairs: NonNullable<Context['cause']['priorRetainedPairs']>;
  readonly continuation: readonly ContinuationFact[];
  readonly propagation: readonly PropagationFact[];
  readonly earliestRead?: readonly (string | number)[];
}
export function validateAfterStrategy(context: Context, plan: BranchPlan): AfterStrategy {
  validateNativeWrites(context, plan.baselineWrites, plan.buildWrites);
  const continuation = proveContinuations(context, plan);
  const propagation = proveChartPropagation(context, plan);
  const prior = priorRetainedWindows(context.a, context.b, context.cause.priorRetainedPairs ?? [], context.index);
  const union = (a: ReadonlySet<NativeFact>, b: ReadonlySet<NativeFact>) => {
    if ([...a].some((row) => b.has(row))) return refuse('one native row has two propagation owners');
    return new Set([...a, ...b]);
  };
  // Only exact original rows from the fully proved primary operation and SAME-object continuation
  // are removed. Every unrelated row still reaches the ONE unchanged semantic comparator.
  if (
    !equalNativeTrace(
      outside(
        context.a,
        context.cause.baseline,
        context.cause.baselineCommit,
        union(continuation.baseline, propagation.baseline),
      ),
      outside(context.b, context.cause.build, context.cause.buildCommit, union(continuation.build, propagation.build)),
      prior.pairs,
    )
  )
    return refuse('independent call/prefix change before FIRST commit');
  return {
    retainedReadWindows: prior.facts,
    priorPairs: prior.pairs,
    continuation: continuation.facts,
    propagation: [...continuation.propagation, ...propagation.facts],
    ...(propagation.earliestRead ? { earliestRead: propagation.earliestRead } : {}),
  };
}
