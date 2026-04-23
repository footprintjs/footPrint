/**
 * Feature: TypedScope — Type-Safe Property Access
 *
 * Define your state as a TypeScript interface. TypedScope gives you
 * typed property access — no casts, no getValue/setValue.
 *
 * Run:  npm run feature:typed-scope
 * Try it: https://footprintjs.github.io/footprint-playground/samples/typed-scope
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

// Define state as a plain TypeScript interface
interface PatientState {
  patientName: string;
  temperature: number;
  unit: 'celsius' | 'fahrenheit';
  temperatureF?: number;
  diagnosis?: string;
}

(async () => {

const chart = flowChart<PatientState>('Intake', async (scope) => {
  scope.patientName = 'Jane Doe';
  scope.temperature = 39.2;
  scope.unit = 'celsius';
}, 'intake')

  .addFunction('ConvertTemp', async (scope) => {
    if (scope.unit === 'celsius') {
      scope.temperatureF = scope.temperature * 1.8 + 32;
    }
  }, 'convert-temp')
  .addFunction('Diagnose', async (scope) => {
    const tempF = scope.temperatureF!;
    const diagnosis = tempF > 100.4 ? 'Fever detected' : 'Normal';
    scope.diagnosis = `${scope.patientName}: ${diagnosis} (${tempF.toFixed(1)}F)`;
  }, 'diagnose')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('=== TypedScope — Typed Property Access ===\n');
executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
console.log('\nNo casts. No getValue/setValue. Just typed properties.');
})().catch(console.error);
