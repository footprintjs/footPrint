/**
 * FlowRecorder: Simple Observer
 *
 * The simplest possible FlowRecorder — an object with `id` and a few hooks.
 * Demonstrates that FlowRecorders observe control flow events without
 * modifying execution behavior.
 *
 * Run:  npm run fr:simple
 * Try it: https://footprintjs.github.io/footprint-playground/samples/simple-observer
 */

import {
  flowChart,
  
  FlowChartExecutor,
  type FlowRecorder,
} from 'footprintjs';

interface SimpleState {
  input: string;
  valid: boolean;
  result: string;
  output: string;
}

(async () => {

// ── Build a simple linear chart ──────────────────────────────────────────

const chart = flowChart<SimpleState>('Validate', async (scope) => {
  scope.input = 'hello';
  scope.valid = true;
}, 'validate')
  .addFunction('Process', async (scope) => {
    scope.result = scope.input.toUpperCase();
  }, 'process')
  .addFunction('Output', async (scope) => {
    scope.output = `Done: ${scope.result}`;
  }, 'output')
  .build();

// ── Attach a simple FlowRecorder ─────────────────────────────────────────

const events: string[] = [];

const observer: FlowRecorder = {
  id: 'simple-observer',
  onStageExecuted: (event) => {
    events.push(`Stage executed: ${event.stageName}`);
  },
  onNext: (event) => {
    events.push(`  -> moved from ${event.from} to ${event.to}`);
  },
};

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(observer);
await executor.run();

console.log('=== Simple FlowRecorder Observer ===\n');
events.forEach((line) => console.log(`  ${line}`));
console.log(`\n  Total events captured: ${events.length}`);

})().catch(console.error);
