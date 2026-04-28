/**
 * select() — Multi-Match Parallel Fan-Out
 *
 * `decide()` is first-match (single branch). `select()` evaluates ALL rules
 * and runs every matched branch in parallel. Use it when conditions are
 * orthogonal — vital-sign screenings, alert categories, retrieval sources —
 * so multiple paths can fire simultaneously off one set of inputs.
 *
 * Run: npx tsx examples/build-time-features/decide-select/04-select-parallel.ts
 */

import { flowChart, FlowChartExecutor, select } from 'footprintjs';

interface VitalsState {
  glucose: number;
  systolicBP: number;
  bmi: number;
  screenings: string[];
}

const chart = flowChart<VitalsState>('Intake', async (scope) => {
  scope.glucose = 128;       // matches diabetes
  scope.systolicBP = 148;    // matches hypertension
  scope.bmi = 25;            // does NOT match obesity
  scope.screenings = [];
}, 'intake')
  .addSelectorFunction('Triage', (scope) => {
    return select(scope, [
      { when: { glucose:    { gt: 100 } }, then: 'diabetes',     label: 'Elevated glucose' },
      { when: { systolicBP: { gt: 140 } }, then: 'hypertension', label: 'High blood pressure' },
      { when: { bmi:        { gt: 30  } }, then: 'obesity',      label: 'High BMI' },
    ]);
  }, 'triage')
    .addFunctionBranch('diabetes', 'DiabetesScreen', async (scope) => {
      scope.screenings = [...scope.screenings, `diabetes(glucose=${scope.glucose})`];
    })
    .addFunctionBranch('hypertension', 'BPFollowUp', async (scope) => {
      scope.screenings = [...scope.screenings, `bp(systolic=${scope.systolicBP})`];
    })
    .addFunctionBranch('obesity', 'BMIAssess', async (scope) => {
      scope.screenings = [...scope.screenings, `bmi(value=${scope.bmi})`];
    })
    .end()
  .addFunction('Report', async (scope) => {
    console.log('Screenings performed:', scope.screenings);
  }, 'report')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('\nNarrative (selection evidence — every rule evaluated):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
