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
  // The execution tree is the run's stages, in the order they ran.
  console.log('Stages run:', snap.executionTree.map((stage) => stage.name).join(' → '));
})().catch(console.error);
