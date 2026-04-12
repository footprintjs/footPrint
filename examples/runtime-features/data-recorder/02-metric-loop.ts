/**
 * Data Recorder — MetricRecorder in Loop (Aggregation)
 *
 * When a stage executes multiple times (loop), MetricRecorder stores
 * one entry per invocation (distinct runtimeStageIds). The aggregated
 * view via getMetrics() sums them by stageName.
 *
 * This verifies that:
 * 1. Each loop iteration gets its own runtimeStageId entry
 * 2. aggregate() sums across all invocations
 * 3. accumulate() can compute progressive totals up to a slider position
 *
 * Pipeline: Init → Process (loop 3x) → Done
 *
 * Run: npx tsx examples/runtime-features/data-recorder/02-metric-loop.ts
 */

import { flowChart, FlowChartExecutor, MetricRecorder } from 'footprintjs';

interface State {
  counter: number;
  target: number;
  total: number;
}

const chart = flowChart<State>('Init', async (scope) => {
  scope.counter = 0;
  scope.target = 3;
  scope.total = 0;
}, 'init')
  .addFunction('Process', async (scope) => {
    scope.counter += 1;
    scope.total += scope.counter * 10;
    if (scope.counter >= scope.target) scope.$break();
  }, 'process')
  .loopTo('process')
  .build();

(async () => {
  const metrics = new MetricRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(metrics);
  await executor.run();

  // Per-step: each loop iteration is a separate entry
  console.log('Per-step entries:');
  for (const [id, m] of metrics.getMap()) {
    console.log(`  ${id}: ${m.stageName} — writes:${m.writeCount}`);
  }

  // Aggregated: grouped by stageName
  const agg = metrics.getMetrics();
  const processMetrics = agg.stageMetrics.get('Process');
  console.log(`\nProcess invocations: ${processMetrics?.invocationCount}`);
  console.log(`Total writes: ${agg.totalWrites}`);

  // Progressive: accumulate up to first 2 steps
  const firstTwo = new Set([...metrics.getMap().keys()].slice(0, 2));
  const writesUpTo2 = metrics.accumulate((sum, m) => sum + m.writeCount, 0, firstTwo);
  console.log(`Writes in first 2 steps: ${writesUpTo2}`);
})().catch(console.error);
