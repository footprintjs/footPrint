import type { JoinedRun } from '../readLawWitness.js';
import { equal, refuse } from '../readLawWitness.js';
import type { BranchReceipt, FixtureCall } from './types.js';

// Whole units moved unchanged from common.ts, exported for its closed continuation sibling.
export function callOrder(calls: readonly FixtureCall[], branch: BranchReceipt) {
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
export function membership(run: JoinedRun, branch: BranchReceipt) {
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
