import type { JoinedRun } from '../readLawWitness.js';
import { nativeTraceComparison, Unproven124 } from '../readLawWitness.js';
import { validateAfterStrategy, validateCommon } from './common.js';
import { chartStrategy } from './strategies/chart.js';
import { writeBackStrategy } from './strategies/writeBack.js';
import type { BranchPlan, Cause, Context, FirstCommitResult, FixtureFamily } from './types.js';

const strategies: Partial<Record<FixtureFamily, (context: Context) => BranchPlan>> = {
  writeback: writeBackStrategy,
  chart: chartStrategy,
};
/** One FIRST boundary; branch helpers cannot grant it or bypass unconditional common/native checks. */
export function firstCommit124(
  a: JoinedRun,
  b: JoinedRun,
  cause: Cause,
  family: FixtureFamily = 'writeback',
): FirstCommitResult {
  try {
    const context = validateCommon(a, b, cause, family);
    const strategy = strategies[family];
    if (!strategy) return { kind: 'unproven', reason: 'No closed branch strategy for actual fixture family.' };
    const declared = strategy(context);
    const continuation = validateAfterStrategy(context, declared);
    return {
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: context.index,
      coordinate: context.cause.baseline.operation.coordinate,
      nativeTrace: nativeTraceComparison([context.cause.pair]),
      ...(continuation.length ? { continuation } : {}),
    };
  } catch (error) {
    return {
      kind: 'unproven',
      reason: error instanceof Unproven124 ? error.message : 'Unreadable FIRST-boundary evidence.',
    };
  }
}
