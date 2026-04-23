/**
 * Feature: Quality Trace — Stack traces for data quality
 *
 * QualityRecorder scores each execution step during traversal.
 * qualityTrace() backtracks from any low-scoring step through the
 * commit log to produce a "Quality Stack Trace" — like an error
 * stack trace, but for data quality.
 *
 * Run:  npx tsx examples/features/22-quality-trace.ts
 */

import {
  flowChart,
  FlowChartExecutor,
  decide,
} from 'footprintjs';

import {
  QualityRecorder,
  qualityTrace,
  formatQualityTrace,
} from 'footprintjs/trace';

// ── State ──────────────────────────────────────────────────────────

interface LoanState {
  creditScore: number;
  dti: number;
  riskTier?: string;
  riskFactors?: string[];
  decision?: string;
}

// ── Build the pipeline ─────────────────────────────────────────────

const chart = flowChart<LoanState>('Seed', async (scope) => {
  scope.creditScore = 580;
  scope.dti = 0.6;
}, 'seed')
  .addFunction('EvalRisk', async (scope) => {
    const factors: string[] = [];
    if (scope.creditScore < 650) factors.push('below-average credit');
    if (scope.dti > 0.43) factors.push('DTI exceeds 43%');
    scope.riskFactors = factors;
    scope.riskTier = factors.length >= 2 ? 'high' : factors.length === 1 ? 'medium' : 'low';
  }, 'eval-risk')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { riskTier: { eq: 'low' } }, then: 'approve', label: 'Low risk' },
      { when: { riskTier: { eq: 'medium' } }, then: 'review', label: 'Medium risk' },
    ], 'reject');
  }, 'route')
    .addFunctionBranch('approve', 'Approve', async (scope) => {
      scope.decision = 'APPROVED';
    })
    .addFunctionBranch('review', 'Review', async (scope) => {
      scope.decision = 'MANUAL REVIEW';
    })
    .addFunctionBranch('reject', 'Reject', async (scope) => {
      scope.decision = 'REJECTED — ' + (scope.riskFactors ?? []).join('; ');
    })
    .setDefault('reject')
    .end()
  .build();

// ── Quality scoring function ───────────────────────────────────────

const quality = new QualityRecorder((runtimeStageId, ctx) => {
  // Score based on what was written
  if (ctx.keysWritten.includes('riskTier')) {
    // Check if high risk = low quality output
    return { score: 0.3, factors: ['high risk tier assigned'] };
  }
  if (ctx.keysWritten.includes('decision')) {
    return { score: 0.2, factors: ['rejection decision'] };
  }
  // Input stage — clean data
  return { score: 1.0, factors: ['input data'] };
});

// ── Run ────────────────────────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  executor.enableNarrative();
  await executor.run();

  // Show narrative
  console.log('=== Narrative ===\n');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  // Show quality scores
  console.log('\n=== Quality Scores ===\n');
  for (const [id, entry] of quality.getMap()) {
    console.log(`  ${id}: score=${entry.score.toFixed(2)} [${entry.factors.join(', ')}]`);
  }
  console.log(`\n  Overall: ${quality.getOverallScore().toFixed(2)}`);

  // Find and trace the lowest-scoring step
  const lowest = quality.getLowest();
  if (lowest) {
    console.log(`\n  Lowest: ${lowest.runtimeStageId} (${lowest.entry.score.toFixed(2)})`);

    const commitLog = executor.getSnapshot().commitLog;
    const trace = qualityTrace(commitLog, quality, lowest.runtimeStageId);

    console.log('\n=== Quality Stack Trace ===\n');
    console.log(formatQualityTrace(trace));
  }
})().catch(console.error);
