/**
 * decide() / select() — Filter Object Rules With Evidence
 *
 * Filter rules use { key: { operator: value } } syntax. The engine
 * automatically captures which values were tested, what the threshold
 * was, and whether each condition passed — producing rich narrative
 * evidence without any manual logging.
 *
 * Run: npx tsx examples/build-time-features/decide-select/01-filter-rules.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface LoanState {
  creditScore: number;
  dti: number;
  decision?: string;
}

const chart = flowChart<LoanState>('Load', async (scope) => {
  scope.creditScore = 750;
  scope.dti = 0.38;
}, 'load')
  .addDeciderFunction('Classify', (scope) => {
    return decide(scope, [
      {
        when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } },
        then: 'approved',
        label: 'Good credit + low DTI',
      },
      {
        when: { creditScore: { gt: 600 } },
        then: 'review',
        label: 'Marginal credit',
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
  console.log('\nNarrative (with evidence):');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
