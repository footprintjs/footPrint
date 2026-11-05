import { refuse } from '../../readLawWitness.js';
import type { BranchPlan, Context } from '../types.js';
import { chartBranchPair } from './chartBranch.js';

/** Frozen host checker stays branch-only; the caller runs every common guard around this adapter. */
export function chartStrategy(context: Context): BranchPlan {
  const result = chartBranchPair(
    context.op as Parameters<typeof chartBranchPair>[0],
    { branch: context.cause.baseline, read: context.reads[0].read },
    { branch: context.cause.build, read: context.reads[1].read },
  );
  if (result.kind !== 'declared-chart-branches') return refuse(result.reason);
  return {
    kind: 'declared-branches',
    strategy: 'chart',
    baselineWrites: result.baselineWrites,
    buildWrites: result.buildWrites,
  };
}
