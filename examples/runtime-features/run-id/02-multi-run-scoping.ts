/**
 * runId — Multi-Run Scoping
 *
 * The classic bug runId fixes: a stateful recorder accumulating
 * across multiple runs of the same executor. WITHOUT runId-scoping,
 * the second run's events alias into the first run's state — silent
 * data corruption.
 *
 * This example shows the correct pattern: detect runId change → reset
 * transient state → accumulate per-run.
 *
 * Run: npx tsx examples/runtime-features/run-id/02-multi-run-scoping.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder } from 'footprintjs';

interface PerRunCounts {
  runId: string;
  stages: number;
}

const chart = flowChart('a', () => null, 'a')
  .addFunction('B', () => null, 'b')
  .addFunction('C', () => null, 'c')
  .build();

(async () => {
  // Per-run rollup: count stages per run. Reset on runId change.
  const completed: PerRunCounts[] = [];
  let current: PerRunCounts | undefined;

  const recorder: FlowRecorder = {
    id: 'per-run-rollup',
    onStageExecuted: (event) => {
      const runId = event.traversalContext?.runId;
      if (!runId) return;
      // New run → finalize the previous one + start fresh.
      if (!current || current.runId !== runId) {
        if (current) completed.push(current);
        current = { runId, stages: 0 };
      }
      current.stages += 1;
    },
    onRunEnd: () => {
      if (current) {
        completed.push(current);
        current = undefined;
      }
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(recorder);

  await executor.run();
  await executor.run();
  await executor.run();

  console.log('per-run rollups:');
  for (const r of completed) console.log(`  runId=${r.runId} stages=${r.stages}`);

  // Output (3 distinct runIds, each counting 3 stages independently):
  //   per-run rollups:
  //     runId=...-001 stages=3
  //     runId=...-002 stages=3
  //     runId=...-003 stages=3
})();
