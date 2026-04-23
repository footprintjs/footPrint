/**
 * Feature: Causal Chain — Backward program slicing on the commit log
 *
 * `causalChain()` answers: "what stages contributed data to this result?"
 * It walks backwards through read→write dependencies, producing a DAG.
 *
 * Uses staged optimization internally:
 * - Small logs (≤ 256): linear scan
 * - Large logs (> 256): reverse index with binary search
 *
 * Run:  npx tsx examples/features/23-causal-chain.ts
 */

import {
  flowChart,
  FlowChartExecutor,
  decide,
} from 'footprintjs';

import {
  causalChain,
  flattenCausalDAG,
  formatCausalChain,
  QualityRecorder,
  qualityTrace,
  formatQualityTrace,
} from 'footprintjs/trace';

// ── State ──────────────────────────────────────────────────────────

interface LoanState {
  creditScore: number;
  dti: number;
  monthlyIncome: number;
  monthlyDebts: number;
  riskTier?: string;
  decision?: string;
}

// ── Pipeline ───────────────────────────────────────────────────────

const chart = flowChart<LoanState>('Seed', async (scope) => {
  scope.creditScore = 580;
  scope.monthlyIncome = 3500;
  scope.monthlyDebts = 2100;
  scope.dti = scope.monthlyDebts / scope.monthlyIncome;
}, 'seed')
  .addFunction('EvalRisk', async (scope) => {
    if (scope.creditScore < 650 && scope.dti > 0.43) {
      scope.riskTier = 'high';
    } else if (scope.creditScore < 700) {
      scope.riskTier = 'medium';
    } else {
      scope.riskTier = 'low';
    }
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
      scope.decision = 'REJECTED — credit ' + scope.creditScore + ', DTI ' + (scope.dti * 100).toFixed(0) + '%';
    })
    .setDefault('reject')
    .end()
  .build();

// ── Quality scoring ────────────────────────────────────────────────

const quality = new QualityRecorder((id, ctx) => {
  if (ctx.keysWritten.includes('decision') && ctx.keysWritten.some(k => k === 'decision')) {
    return { score: 0.2, factors: ['rejection decision'] };
  }
  if (ctx.keysWritten.includes('riskTier')) {
    return { score: 0.4, factors: ['high risk assigned'] };
  }
  return { score: 1.0, factors: ['input data'] };
});

// ── Run ────────────────────────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  executor.enableNarrative();
  await executor.run();

  const snapshot = executor.getSnapshot();
  const commitLog = snapshot.commitLog;

  // 1. Show narrative
  console.log('=== Narrative ===\n');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  // 2. Raw causal chain — no quality scores, just data lineage
  console.log('\n=== Causal Chain (from Reject stage) ===\n');

  // Find the reject stage's runtimeStageId
  const rejectCommit = commitLog.find(c => c.stageId === 'sf-route/reject' || c.trace.some(t => t.path === 'decision'));
  if (rejectCommit) {
    const dag = causalChain(
      commitLog,
      rejectCommit.runtimeStageId,
      (id) => quality.getByKey(id)?.keysRead ?? [],
    );

    if (dag) {
      console.log(formatCausalChain(dag));
      console.log(`\n  Total nodes in DAG: ${flattenCausalDAG(dag).length}`);
    }
  }

  // 3. Quality stack trace — causal chain decorated with scores
  console.log('\n=== Quality Stack Trace ===\n');
  const lowest = quality.getLowest();
  if (lowest) {
    const trace = qualityTrace(commitLog, quality, lowest.runtimeStageId);
    console.log(formatQualityTrace(trace));
  }

  console.log(`\n  Overall quality: ${quality.getOverallScore().toFixed(2)}`);
})().catch(console.error);
