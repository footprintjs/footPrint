/**
 * Feature: decide() / select() — Decision Reasoning Capture
 *
 * Auto-captures WHY a decider chose a branch or a selector picked paths.
 * Two when formats:
 * - Function: (s) => s.creditScore > 700  (auto-captures which keys were read)
 * - Filter:   { creditScore: { gt: 700 } } (captures keys + operators + thresholds)
 *
 * Run:  npm run feature:decide
 * Try it: https://footprintjs.github.io/footprint-playground/samples/decide-select
 */

import {
  flowChart,
  FlowChartExecutor,
  decide,
  select,
} from 'footprintjs';

// ── State types ─────────────────────────────────────────────────────────

interface LoanState {
  creditScore: number;
  dti: number;
  employmentStatus: string;
  decision?: string;
}

interface ScreeningState {
  glucose: number;
  systolicBP: number;
  bmi: number;
  results: string[];
}

(async () => {

// ── Scenario 1: decide() with filter rules ──────────────────────────────

console.log('=== Scenario 1: decide() with filter rules ===\n');

const loanChart = flowChart<LoanState>('LoadApplication', async (scope) => {
  scope.creditScore = 750;
  scope.dti = 0.38;
  scope.employmentStatus = 'employed';
}, 'load-app')

  .addDeciderFunction('ClassifyRisk', (scope) => {
    return decide(scope, [
      {
        when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } },
        then: 'approved',
        label: 'Good credit + low DTI',
      },
      {
        when: { creditScore: { gt: 600 } },
        then: 'manual-review',
        label: 'Marginal credit',
      },
    ], 'rejected');
  }, 'classify-risk', 'Evaluate loan risk and route accordingly')
    .addFunctionBranch('approved', 'Approve', async (scope) => {
      scope.decision = 'Approved - excellent profile';
    }, 'Generate approval')
    .addFunctionBranch('manual-review', 'Review', async (scope) => {
      scope.decision = 'Sent to manual review';
    }, 'Queue for review')
    .addFunctionBranch('rejected', 'Reject', async (scope) => {
      scope.decision = 'Rejected';
    }, 'Generate rejection')
    .setDefault('rejected')
    .end()
  .build();

const loanExecutor = new FlowChartExecutor(loanChart);
loanExecutor.enableNarrative();
await loanExecutor.run();

console.log('Narrative (filter evidence shows operators + thresholds):');
loanExecutor.getNarrative().forEach((line) => console.log(`  ${line}`));

// ── Scenario 2: decide() with function rules ────────────────────────────

console.log('\n=== Scenario 2: decide() with function rules ===\n');

const functionChart = flowChart<LoanState>('LoadApp', async (scope) => {
  scope.creditScore = 650;
  scope.dti = 0.50;
  scope.employmentStatus = 'self-employed';
}, 'load-app-2')

  .addDeciderFunction('ClassifyRisk', (scope) => {
    return decide(scope, [
      {
        when: (s) => s.creditScore > 700 && s.dti < 0.43 && s.employmentStatus !== 'unemployed',
        then: 'approved',
        label: 'Full qualification',
      },
      {
        when: (s) => s.creditScore > 600,
        then: 'manual-review',
        label: 'Marginal - needs review',
      },
    ], 'rejected');
  }, 'classify-risk', 'Route based on credit profile')
    .addFunctionBranch('approved', 'Approve', async (scope) => { scope.decision = 'Approved'; })
    .addFunctionBranch('manual-review', 'Review', async (scope) => { scope.decision = 'Manual review'; })
    .addFunctionBranch('rejected', 'Reject', async (scope) => { scope.decision = 'Rejected'; })
    .setDefault('rejected')
    .end()
  .build();

const fnExecutor = new FlowChartExecutor(functionChart);
fnExecutor.enableNarrative();
await fnExecutor.run();

console.log('Narrative (function evidence shows which keys were read):');
fnExecutor.getNarrative().forEach((line) => console.log(`  ${line}`));

// ── Scenario 3: select() for multi-match ────────────────────────────────

console.log('\n=== Scenario 3: select() for multi-match screening ===\n');

const screeningChart = flowChart<ScreeningState>('LoadVitals', async (scope) => {
  scope.glucose = 128;
  scope.systolicBP = 148;
  scope.bmi = 25;
  scope.results = [];
}, 'load-vitals')

  .addSelectorFunction('Triage', (scope) => {
    return select(scope, [
      { when: { glucose: { gt: 100 } }, then: 'diabetes', label: 'Elevated glucose' },
      { when: { systolicBP: { gt: 140 } }, then: 'hypertension', label: 'High BP' },
      { when: { bmi: { gt: 30 } }, then: 'obesity', label: 'High BMI' },
    ]);
  }, 'triage', 'Select screenings based on vitals')
    .addFunctionBranch('diabetes', 'DiabetesScreen', async (scope) => {
      scope.results = [...scope.results, 'Diabetes screening: glucose ' + scope.glucose];
    })
    .addFunctionBranch('hypertension', 'BPCheck', async (scope) => {
      scope.results = [...scope.results, 'BP check: systolic ' + scope.systolicBP];
    })
    .addFunctionBranch('obesity', 'BMIAssess', async (scope) => {
      scope.results = [...scope.results, 'BMI assessment: ' + scope.bmi];
    })
    .end()
  .addFunction('Report', async (scope) => {
    console.log('  Screenings performed:');
    scope.results.forEach((r) => console.log(`    - ${r}`));
  }, 'report')
  .build();

const screeningExecutor = new FlowChartExecutor(screeningChart);
screeningExecutor.enableNarrative();
await screeningExecutor.run();

console.log('\nNarrative:');
screeningExecutor.getNarrative().forEach((line) => console.log(`  ${line}`));

console.log('\n=== Summary ===');
console.log('  decide(): first-match, auto-captures decision evidence');
console.log('  select(): all-match, auto-captures selection evidence');
console.log('  Filter when: { key: { gt: threshold } } — captures operators + thresholds');
console.log('  Function when: (s) => s.key > threshold — captures which keys were read');

})().catch(console.error);
