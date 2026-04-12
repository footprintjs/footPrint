/**
 * Causal Chain — Diamond (Fan-in DAG)
 *
 * Two parallel branches both read from the same seed, then a
 * merge stage reads from both. The causal DAG has a diamond shape:
 *
 *        Seed
 *       /    \
 *   BranchA  BranchB
 *       \    /
 *        Merge
 *
 * This verifies that causalChain() produces a true DAG (shared parent
 * node for Seed) rather than duplicating it in each branch.
 *
 * Pipeline: Seed → Fork(BranchA + BranchB) → Merge
 *
 * Run: npx tsx examples/post-execution/causal-chain/05-diamond.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { causalChain, flattenCausalDAG, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

interface State {
  x: number;
  y: number;
  sumA?: number;
  sumB?: number;
  total?: number;
}

const chart = flowChart<State>('Seed', async (scope) => {
  scope.x = 10;
  scope.y = 20;
}, 'seed')
  .addFunction('BranchA', async (scope) => {
    scope.sumA = scope.x * 2;
  }, 'branch-a')
  .addFunction('BranchB', async (scope) => {
    scope.sumB = scope.y * 3;
  }, 'branch-b')
  .addFunction('Merge', async (scope) => {
    scope.total = (scope.sumA ?? 0) + (scope.sumB ?? 0);
  }, 'merge')
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const mergeCommit = commitLog.find(c => c.stageId === 'merge')!;

  const dag = causalChain(commitLog, mergeCommit.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  console.log(formatCausalChain(dag!));

  const flat = flattenCausalDAG(dag!);
  console.log(`\nDAG nodes: ${flat.length}`);
  // Should be 4: Merge, BranchA, BranchB, Seed (Seed shared, not duplicated)
  console.log(`Seed appears: ${flat.filter(n => n.stageName === 'Seed').length} time(s) (should be 1 — DAG sharing)`);
})().catch(console.error);
