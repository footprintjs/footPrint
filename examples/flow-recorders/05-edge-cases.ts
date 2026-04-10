/**
 * FlowRecorder: Edge Cases and Performance
 *
 * Demonstrates FlowRecorder behavior at the boundaries:
 *   - Zero loops (no loop events at all)
 *   - Single iteration
 *   - High iteration count (1000 loops)
 *   - Mixed loop targets
 *   - Performance measurement with many recorders
 *
 * Run:  npm run fr:edge-cases
 * Try it: https://footprintjs.github.io/footprint-playground/samples/recorder-edge-cases
 */

import {
  flowChart,
  
  FlowChartExecutor,
  WindowedNarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  AdaptiveNarrativeFlowRecorder,
  ProgressiveNarrativeFlowRecorder,
  RLENarrativeFlowRecorder,
  type FlowRecorder,
} from 'footprintjs';

interface LoopState {
  counter: number;
  target: number;
}

interface LinearState {
  step: string;
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

function buildNoLoopChart() {
  return flowChart<LinearState>('A', async (scope) => {
    scope.step = 'a';
  }, 'a')
    .addFunction('B', async (scope) => {
      scope.step = 'b';
    }, 'b')
    .addFunction('C', async (scope) => {
      scope.step = 'c';
    }, 'c')
    .build();
}

(async () => {

  // ── 1. Zero loops ──────────────────────────────────────────────────────

  console.log('=== 1. Zero Loops (linear chart, no loop events) ===\n');

  const windowed = new WindowedNarrativeFlowRecorder(3, 2);
  let executor = new FlowChartExecutor(buildNoLoopChart());
  executor.attachFlowRecorder(windowed);
  await executor.run();

  console.log(`  Sentences: ${executor.getFlowNarrative().length}`);
  console.log(`  Suppressed loops: ${windowed.getSuppressedCount()}`);
  executor.getFlowNarrative().forEach((line) => console.log(`    ${line}`));
  console.log();

  // ── 2. Single iteration ────────────────────────────────────────────────

  console.log('=== 2. Single Loop Iteration ===\n');

  const strategies = [
    { name: 'Windowed', recorder: new WindowedNarrativeFlowRecorder(3, 2) },
    { name: 'Silent', recorder: new SilentNarrativeFlowRecorder() },
    { name: 'Adaptive', recorder: new AdaptiveNarrativeFlowRecorder(5, 10) },
    { name: 'Progressive', recorder: new ProgressiveNarrativeFlowRecorder() },
    { name: 'RLE', recorder: new RLENarrativeFlowRecorder() },
  ];

  for (const { name, recorder } of strategies) {
    executor = new FlowChartExecutor(buildLoopChart(2)); // 1 loop iteration
    executor.attachFlowRecorder(recorder);
    await executor.run();
    const loopSentences = executor.getFlowNarrative().filter(s => s.includes('pass') || s.includes('Looped'));
    console.log(`  ${name}: ${loopSentences.length} loop sentence(s) -> ${loopSentences[0] ?? '(none)'}`);
  }
  console.log();

  // ── 3. High iteration count ────────────────────────────────────────────

  console.log('=== 3. High Iteration Count (1000 loops) ===\n');

  const highStrategies = [
    { name: 'Windowed(3,2)', recorder: new WindowedNarrativeFlowRecorder(3, 2) },
    { name: 'Silent', recorder: new SilentNarrativeFlowRecorder() },
    { name: 'Adaptive(5,50)', recorder: new AdaptiveNarrativeFlowRecorder(5, 50) },
    { name: 'Progressive(2)', recorder: new ProgressiveNarrativeFlowRecorder(2) },
    { name: 'RLE', recorder: new RLENarrativeFlowRecorder() },
  ];

  for (const { name, recorder } of highStrategies) {
    executor = new FlowChartExecutor(buildLoopChart(1000));
    executor.attachFlowRecorder(recorder);
    const start = performance.now();
    await executor.run();
    const elapsed = (performance.now() - start).toFixed(1);
    const sentences = executor.getFlowNarrative();
    console.log(`  ${name}: ${sentences.length} sentences in ${elapsed}ms`);
  }
  console.log();

  // ── 4. Performance: Many recorders ─────────────────────────────────────

  console.log('=== 4. Performance: 50 Recorders Attached ===\n');

  executor = new FlowChartExecutor(buildLoopChart(100));

  const noopRecorders: FlowRecorder[] = [];
  for (let i = 0; i < 50; i++) {
    const r: FlowRecorder = {
      id: `noop-${i}`,
      onLoop: () => {},
      onStageExecuted: () => {},
    };
    noopRecorders.push(r);
    executor.attachFlowRecorder(r);
  }

  const start = performance.now();
  await executor.run();
  const elapsed = (performance.now() - start).toFixed(1);

  console.log(`  50 recorders x 100 loop iterations = ~5,000 hook calls`);
  console.log(`  Total execution time: ${elapsed}ms`);
  console.log(`  Overhead per hook call: ~${((performance.now() - start) / 5000 * 1000).toFixed(0)}us`);

})().catch(console.error);
