/**
 * Feature: FlowRecorder — Pluggable observers for control flow events
 *
 * FlowRecorder mirrors the scope-level Recorder pattern for the engine layer.
 * Observe decisions, loops, forks, and other control flow events.
 *
 * Run:  npm run feature:flow-recorders
 * Try it: https://footprintjs.github.io/footprint-playground/samples/flow-recorders
 */

import {
  flowChart,
  FlowChartExecutor,
  type FlowRecorder,
  NarrativeFlowRecorder,
  WindowedNarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  SeparateNarrativeFlowRecorder,
  AdaptiveNarrativeFlowRecorder,
} from 'footprintjs';

interface LoopState {
  counter: number;
  target: number;
}

function buildLoopChart(iterations = 20) {
  return flowChart<LoopState>('Init', async (scope) => {
    scope.counter = 0;
    scope.target = iterations;
  }, 'init')
    .addFunction('Process', async (scope) => {
      scope.counter = scope.counter + 1;
      if (scope.counter < scope.target) {
        return { name: 'loop-back', next: { name: 'Process', id: 'process' } };
      }
    }, 'process')
    .build();
}

(async () => {

  console.log('=== 1. Custom FlowRecorder (Metrics) ===\n');

  const metrics: FlowRecorder = {
    id: 'metrics',
    onStageExecuted: (event) => {
      console.log(`  [metric] stage: ${event.stageName}`);
    },
    onLoop: (event) => {
      if (event.iteration <= 3 || event.iteration % 5 === 0) {
        console.log(`  [metric] loop iteration ${event.iteration} -> ${event.target}`);
      }
    },
    onBreak: (event) => {
      console.log(`  [metric] break at ${event.stageName}`);
    },
  };

  const narrator1 = new NarrativeFlowRecorder();
  let executor = new FlowChartExecutor(buildLoopChart(10));
  executor.attachFlowRecorder(narrator1);
  executor.attachFlowRecorder(metrics);
  await executor.run();
  console.log(`\n  Flow narrative: ${executor.getFlowNarrative().length} sentences\n`);

  console.log('=== 2. Windowed Strategy (first 3 + last 2) ===\n');

  executor = new FlowChartExecutor(buildLoopChart(20));
  executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
  await executor.run();
  executor.getFlowNarrative().forEach((line) => console.log(`  ${line}`));
  console.log();

  console.log('=== 3. Silent Strategy (summary only) ===\n');

  executor = new FlowChartExecutor(buildLoopChart(20));
  executor.attachFlowRecorder(new SilentNarrativeFlowRecorder());
  await executor.run();
  executor.getFlowNarrative().forEach((line) => console.log(`  ${line}`));
  console.log();

  console.log('=== 4. Adaptive Strategy (full for 3, then every 5th) ===\n');

  executor = new FlowChartExecutor(buildLoopChart(20));
  executor.attachFlowRecorder(new AdaptiveNarrativeFlowRecorder(3, 5));
  await executor.run();
  executor.getFlowNarrative().forEach((line) => console.log(`  ${line}`));
  console.log();

  console.log('=== 5. Separate Strategy (main + loop detail channels) ===\n');

  const separate = new SeparateNarrativeFlowRecorder();
  executor = new FlowChartExecutor(buildLoopChart(20));
  executor.attachFlowRecorder(separate);
  await executor.run();

  console.log('  Main narrative:');
  executor.getFlowNarrative().forEach((line) => console.log(`    ${line}`));
  console.log(`\n  Loop detail (${separate.getLoopSentences().length} sentences):`);
  separate.getLoopSentences().slice(0, 3).forEach((line) => console.log(`    ${line}`));
  if (separate.getLoopSentences().length > 3) console.log('    ...');
  console.log(`\n  Loop counts:`, Object.fromEntries(separate.getLoopCounts()));

})().catch(console.error);
