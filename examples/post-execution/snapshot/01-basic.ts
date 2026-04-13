/**
 * Snapshot — Basic State Inspection
 *
 * getSnapshot() returns the full execution state: shared state,
 * execution tree, commit log, and recorder snapshots.
 *
 * Run: npx tsx examples/post-execution/snapshot/01-basic.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface State { input: string; output?: string }

const chart = flowChart<State>('Process', async (scope) => {
  scope.input = 'hello';
  scope.output = scope.input.toUpperCase();
}, 'process')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const snap = executor.getSnapshot();
  console.log('Shared state:', snap.sharedState);
  console.log('Commit log entries:', snap.commitLog.length);
  console.log('Execution tree root:', snap.executionTree?.name);
})().catch(console.error);
