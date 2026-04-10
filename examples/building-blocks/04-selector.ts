/**
 * Flowchart: Selector (Multi-Branch) with select()
 *
 * Uses select() for automatic screening evidence capture.
 * ALL matching branches execute in parallel.
 *
 *                       +-- DiabetesScreening --+
 *   LoadPatient -> Triage +-- HypertensionCheck --+-> GenerateReport
 *                       +-- ObesityAssessment --+
 * Try it: https://footprintjs.github.io/footprint-playground/samples/selector
 */

import {
  flowChart,
  FlowChartExecutor,
  select,
} from 'footprintjs';

interface SelectorState {
  patient: {
    name: string;
    age: number;
    vitals: { bmi: number; bloodPressure: string; fastingGlucose: number };
    conditions: string[];
    medications: string[];
  };
  screeningResults: Array<{ condition: string; risk: string; detail: string; recommendation: string }>;
  reportGenerated?: boolean;
}

(async () => {

const patientDB = new Map([
  ['P-101', {
    name: 'Maria Garcia',
    age: 58,
    vitals: { bmi: 31.2, bloodPressure: '148/92', fastingGlucose: 128 },
    conditions: ['diabetes', 'hypertension'],
    medications: ['lisinopril', 'metformin'],
  }],
]);

const chart = flowChart<SelectorState>('LoadPatient', async (scope) => {
  scope.patient = patientDB.get('P-101')!;
  scope.screeningResults = [];
}, 'load-patient')

  .addSelectorFunction('Triage', (scope) => {
    // select() auto-captures which vitals triggered each screening
    return select(scope, [
      {
        when: (s) => s.patient.vitals.fastingGlucose > 100,
        then: 'diabetes',
        label: 'Elevated fasting glucose',
      },
      {
        when: (s) => parseInt(s.patient.vitals.bloodPressure) > 140,
        then: 'hypertension',
        label: 'High systolic BP',
      },
      {
        when: (s) => s.patient.vitals.bmi > 30,
        then: 'obesity',
        label: 'Elevated BMI',
      },
    ]);
  }, 'triage', 'Select screenings based on patient vitals')
    .addFunctionBranch('diabetes', 'DiabetesScreening', async (scope) => {
      const glucose = scope.patient.vitals.fastingGlucose;
      const risk = glucose > 126 ? 'high' : 'moderate';
      scope.screeningResults = [...scope.screeningResults, {
        condition: 'Type 2 Diabetes', risk,
        detail: `Fasting glucose: ${glucose} mg/dL`,
        recommendation: risk === 'high' ? 'Schedule HbA1c test' : 'Recheck in 6 months',
      }];
    }, 'Assess diabetes risk')
    .addFunctionBranch('hypertension', 'HypertensionCheck', async (scope) => {
      const systolic = parseInt(scope.patient.vitals.bloodPressure);
      const risk = systolic > 140 ? 'high' : 'moderate';
      scope.screeningResults = [...scope.screeningResults, {
        condition: 'Hypertension', risk,
        detail: `BP: ${scope.patient.vitals.bloodPressure} mmHg`,
        recommendation: risk === 'high' ? 'Adjust medication' : 'Monitor weekly',
      }];
    }, 'Evaluate blood pressure')
    .addFunctionBranch('obesity', 'ObesityAssessment', async (scope) => {
      const bmi = scope.patient.vitals.bmi;
      const severity = bmi > 35 ? 'severe' : 'moderate';
      scope.screeningResults = [...scope.screeningResults, {
        condition: 'Obesity', risk: severity,
        detail: `BMI: ${bmi}`,
        recommendation: 'Refer to nutritionist',
      }];
    }, 'Assess BMI severity')
    .end()
  .addFunction('GenerateReport', async (scope) => {
    console.log(`\n  Patient: ${scope.patient.name} (age ${scope.patient.age})`);
    scope.screeningResults.forEach((r) => {
      console.log(`  - ${r.condition}: ${r.risk} risk -- ${r.detail}`);
      console.log(`    -> ${r.recommendation}`);
    });
    scope.reportGenerated = true;
  }, 'generate-report', 'Generate screening report')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('\n=== Selector with select() ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
