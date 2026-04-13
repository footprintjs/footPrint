/**
 * Quality Trace — Root Cause Detection
 *
 * QualityRecorder scores each step. qualityTrace() backtracks from
 * the lowest-scoring step to find where quality dropped most.
 *
 * Pipeline: Seed (1.0) → EvalRisk (0.4) → Reject (0.2)
 * Root cause: quality dropped at Reject (0.4 → 0.2)
 *
 * Run: npx tsx examples/post-execution/quality-trace/02-root-cause.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import { QualityRecorder, qualityTrace, formatQualityTrace } from 'footprintjs/trace';

interface State { creditScore: number; riskTier?: string; decision?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.creditScore = 580;
}, 'seed')
  .addFunction('EvalRisk', async (scope) => {
    scope.riskTier = scope.creditScore < 650 ? 'high' : 'low';
  }, 'eval-risk')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { riskTier: { eq: 'low' } }, then: 'approve', label: 'Low risk' },
    ], 'reject');
  }, 'route')
    .addFunctionBranch('approve', 'Approve', async (scope) => { scope.decision = 'APPROVED'; })
    .addFunctionBranch('reject', 'Reject', async (scope) => { scope.decision = 'REJECTED'; })
    .setDefault('reject')
    .end()
  .build();

(async () => {
  const quality = new QualityRecorder((id, ctx) => {
    if (ctx.keysWritten.includes('decision')) return { score: 0.2, factors: ['rejection'] };
    if (ctx.keysWritten.includes('riskTier')) return { score: 0.4, factors: ['high risk'] };
    return { score: 1.0 };
  });

  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const lowest = quality.getLowest()!;
  const trace = qualityTrace(executor.getSnapshot().commitLog, quality, lowest.runtimeStageId);
  console.log(formatQualityTrace(trace));
  console.log(`\nRoot cause: ${trace.rootCause?.frame.runtimeStageId} (drop: ${trace.rootCause?.drop.toFixed(2)})`);
})().catch(console.error);
