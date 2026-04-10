/**
 * Feature: Auto-generated Narrative
 *
 * Call executor.enableNarrative() before run(). The library automatically
 * observes every read/write and merges it with control-flow events.
 * Call executor.getNarrative() to get the full causal trace — zero setup.
 *
 * Run:  npm run feature:narrative
 * Try it: https://footprintjs.github.io/footprint-playground/samples/narrative
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

interface TempState {
  temperature: number;
  unit: string;
  temperatureF?: number;
  converted?: boolean;
  status?: string;
}

(async () => {

const chart = flowChart<TempState>('Ingest', async (scope) => {
  scope.temperature = 38.5;
  scope.unit = 'celsius';
}, 'ingest')

  .addFunction('Convert', async (scope) => {
    if (scope.unit === 'celsius') {
      scope.temperatureF = scope.temperature * 1.8 + 32;
      scope.converted = true;
    }
  }, 'convert')
  .addFunction('Classify', async (scope) => {
    scope.status = scope.temperatureF! > 100.4 ? 'fever' : 'normal';
  }, 'classify')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('=== Auto-generated Narrative ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));
console.log('\nNo casts, no scopeFactory boilerplate.');
console.log('Just flowChart<T>() + enableNarrative() + getNarrative().');
})().catch(console.error);
