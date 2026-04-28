/**
 * decide() — Function When Rules
 *
 * Function `when` clauses run arbitrary predicates. The engine's read-tracking
 * captures WHICH scope keys the function touched, so the narrative still
 * shows evidence ("the function read creditScore=650, dti=0.50") without
 * requiring you to log it manually.
 *
 * Compare with 01-filter-rules.ts (declarative thresholds): function rules
 * give you full TypeScript expressivity in exchange for slightly weaker
 * evidence (operators are not captured — only the keys that were read).
 *
 * Run: npx tsx examples/build-time-features/decide-select/02-function-rules.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface LoanState {
  creditScore: number;
  dti: number;
  employmentStatus: string;
  decision?: string;
}

const chart = flowChart<LoanState>('Load', async (scope) => {
  scope.creditScore = 650;
  scope.dti = 0.50;
  scope.employmentStatus = 'self-employed';
}, 'load')
  .addDeciderFunction('Classify', (scope) => {
    return decide(scope, [
      {
        when: (s) => s.creditScore > 700 && s.dti < 0.43 && s.employmentStatus !== 'unemployed',
        then: 'approved',
        label: 'Full qualification',
      },
      {
        when: (s) => s.creditScore > 600,
        then: 'review',
        label: 'Marginal — needs review',
      },
    ], 'rejected');
  }, 'classify')
    .addFunctionBranch('approved', 'Approve', async (scope) => { scope.decision = 'Approved'; })
    .addFunctionBranch('review', 'Review', async (scope) => { scope.decision = 'Manual review'; })
    .addFunctionBranch('rejected', 'Reject', async (scope) => { scope.decision = 'Rejected'; })
    .setDefault('rejected')
    .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('Decision:', executor.getSnapshot().sharedState?.decision);
  console.log('\nNarrative (function evidence — which keys were read):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
