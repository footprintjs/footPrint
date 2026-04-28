/**
 * decide() — Mixed Filter + Function Rules
 *
 * `decide()` evaluates rules in order; you can mix filter and function
 * `when` clauses freely in the same call. Use filter clauses for crisp
 * threshold checks (better evidence — operators captured) and function
 * clauses for expressions filters can't represent (cross-field math,
 * regex tests, calls into helpers).
 *
 * Run: npx tsx examples/build-time-features/decide-select/03-mixed-rules.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface ApplicationState {
  creditScore: number;
  income: number;
  monthlyDebt: number;
  email: string;
  decision?: string;
}

const chart = flowChart<ApplicationState>('Load', async (scope) => {
  scope.creditScore = 720;
  scope.income = 95000;
  scope.monthlyDebt = 2800;
  scope.email = 'applicant@gmail.com';
}, 'load')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      // Filter rule — captures operator + threshold in evidence
      {
        when: { creditScore: { gte: 750 } },
        then: 'fast-track',
        label: 'Excellent credit',
      },
      // Function rule — cross-field DTI math (can't express as a filter)
      {
        when: (s) => (s.monthlyDebt * 12) / s.income < 0.36,
        then: 'standard',
        label: 'Healthy DTI',
      },
      // Function rule — regex against a free-form field
      {
        when: (s) => /@(gmail|outlook|yahoo)\.com$/.test(s.email),
        then: 'standard',
        label: 'Verified personal email',
      },
    ], 'manual-review');
  }, 'route')
    .addFunctionBranch('fast-track', 'FastTrack', async (scope) => { scope.decision = 'fast-track'; })
    .addFunctionBranch('standard', 'Standard', async (scope) => { scope.decision = 'standard'; })
    .addFunctionBranch('manual-review', 'Review', async (scope) => { scope.decision = 'manual-review'; })
    .setDefault('manual-review')
    .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('Decision:', executor.getSnapshot().sharedState?.decision);
  console.log('\nNarrative (mixed evidence — filter operators AND function reads):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
