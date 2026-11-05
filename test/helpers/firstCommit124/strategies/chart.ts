import { refuse } from '../../readLawWitness.js';
import type { BranchPlan, Context } from '../types.js';
import { chartBranchPair } from './chartBranch.js';

/** The checker stays branch-only; the caller runs every common guard around this adapter. */
export function chartStrategy(context: Context): BranchPlan {
  const result = chartBranchPair(
    context.op as Parameters<typeof chartBranchPair>[0],
    { branch: context.cause.baseline, read: context.reads[0].read, native: context.a.native },
    { branch: context.cause.build, read: context.reads[1].read, native: context.b.native },
  );
  if (result.kind !== 'declared-chart-branches') return refuse(result.reason);
  return {
    kind: 'declared-branches',
    strategy: 'chart',
    baselineWrites: result.baselineWrites,
    buildWrites: result.buildWrites,
  };
}
