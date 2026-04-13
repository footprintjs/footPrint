/**
 * Snapshot — Commit Log Queries
 *
 * The commit log is an ordered array of what each stage wrote.
 * findLastWriter() and findCommit() query it for backtracking.
 *
 * Run: npx tsx examples/post-execution/snapshot/03-commit-log.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { findLastWriter, findCommit } from 'footprintjs/trace';

interface State { x: number; y?: number; z?: string }

const chart = flowChart<State>('A', async (scope) => { scope.x = 42; }, 'a')
  .addFunction('B', async (scope) => { scope.y = scope.x * 2; }, 'b')
  .addFunction('C', async (scope) => { scope.z = `result: ${scope.y}`; }, 'c')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  console.log(`Commits: ${commitLog.length}`);

  for (const c of commitLog) {
    const keys = c.trace.map((t) => t.path).join(', ');
    console.log(`  ${c.runtimeStageId}: wrote ${keys}`);
  }

  // Who last wrote 'y' before commit index 2?
  const writer = findLastWriter(commitLog, 'y', 2);
  console.log(`\nLast writer of 'y' before idx 2: ${writer?.runtimeStageId}`);

  // Find commit for stage 'a'
  const aCommit = findCommit(commitLog, 'a');
  console.log(`Commit for 'a': wrote ${aCommit?.trace.map((t) => t.path).join(', ')}`);
})().catch(console.error);
