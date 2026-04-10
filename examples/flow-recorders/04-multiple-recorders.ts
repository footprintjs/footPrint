/**
 * FlowRecorder: Multiple Recorders
 *
 * Demonstrates attaching multiple FlowRecorders to the same execution.
 * Each recorder sees the same events independently — like scope Recorders
 * but for control flow.
 *
 * Shows:
 *   - Narrative + metrics side-by-side
 *   - Detaching a recorder mid-lifecycle
 *   - Error isolation (one recorder failing doesn't affect others)
 *
 * Run:  npm run fr:multiple
 * Try it: https://footprintjs.github.io/footprint-playground/samples/multiple-recorders
 */

import {
  flowChart,
  
  FlowChartExecutor,
  NarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  type FlowRecorder,
} from 'footprintjs';

interface LoopState {
  counter: number;
  target: number;
}

function buildLoopChart(iterations: number) {
  return flowChart<LoopState>('Init', async (scope) => {
    scope.counter = 0;
    scope.target = iterations;
  }, 'init')
    .addFunction('Process', async (scope) => {
      scope.counter = scope.counter + 1;
      if (scope.counter >= scope.target) scope.$break();
    }, 'process')
    .loopTo('process')
    .build();
}

(async () => {

  // ── 1. Narrative + Metrics side-by-side ────────────────────────────────

  console.log('=== 1. Two Recorders: Narrative + Metrics ===\n');

  const silent = new SilentNarrativeFlowRecorder();
  const loopTimings: number[] = [];
  let lastTime = Date.now();

  const timingRecorder: FlowRecorder = {
    id: 'timing',
    onLoop: () => {
      const now = Date.now();
      loopTimings.push(now - lastTime);
      lastTime = now;
    },
  };

  let executor = new FlowChartExecutor(buildLoopChart(10));
  executor.attachFlowRecorder(silent);
  executor.attachFlowRecorder(timingRecorder);
  await executor.run();

  console.log('  Narrative (silent):');
  executor.getFlowNarrative().forEach((line) => console.log(`    ${line}`));
  console.log(`  Timing recorder captured: ${loopTimings.length} loop timings`);
  console.log();

  // ── 2. Recorder list management ────────────────────────────────────────

  console.log('=== 2. Attach / Detach / List ===\n');

  executor = new FlowChartExecutor(buildLoopChart(5));
  executor.attachFlowRecorder(new NarrativeFlowRecorder());
  executor.attachFlowRecorder({ id: 'audit', onLoop: () => {} });
  executor.attachFlowRecorder({ id: 'debug', onStageExecuted: () => {} });

  console.log(`  Attached: ${executor.getFlowRecorders().map(r => r.id).join(', ')}`);

  executor.detachFlowRecorder('debug');
  console.log(`  After detach('debug'): ${executor.getFlowRecorders().map(r => r.id).join(', ')}`);

  await executor.run();
  console.log(`  Narrative sentences: ${executor.getFlowNarrative().length}`);
  console.log();

  // ── 3. Error isolation ─────────────────────────────────────────────────

  console.log('=== 3. Error Isolation ===\n');

  const errorRecorder: FlowRecorder = {
    id: 'broken',
    onStageExecuted: () => { throw new Error('I crashed!'); },
    onLoop: () => { throw new Error('Loop crash!'); },
  };

  const goodRecorder = new NarrativeFlowRecorder();

  executor = new FlowChartExecutor(buildLoopChart(5));
  executor.attachFlowRecorder(errorRecorder);
  executor.attachFlowRecorder(goodRecorder);
  await executor.run();

  console.log('  Broken recorder threw errors, but execution continued.');
  console.log(`  Good recorder captured: ${executor.getFlowNarrative().length} sentences`);
  executor.getFlowNarrative().forEach((line) => console.log(`    ${line}`));

})().catch(console.error);
