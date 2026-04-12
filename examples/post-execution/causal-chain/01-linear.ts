/**
 * Causal Chain — Linear Pipeline
 *
 * The simplest backtrack: C reads from B reads from A.
 * The causal DAG is a straight line: C ← B ← A.
 *
 * Pipeline: Seed → Process → Format
 *
 * Run: npx tsx examples/post-execution/causal-chain/01-linear.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { causalChain, flattenCausalDAG, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

interface State { input: string; processed?: string; output?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.input = 'hello';
}, 'seed')
  .addFunction('Process', async (scope) => {
    scope.processed = scope.input.toUpperCase();
  }, 'process')
  .addFunction('Format', async (scope) => {
    scope.output = `[${scope.processed}]`;
  }, 'format')
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const formatCommit = commitLog.find(c => c.stageId === 'format')!;

  const dag = causalChain(commitLog, formatCommit.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  console.log(formatCausalChain(dag!));
  console.log(`\nNodes: ${flattenCausalDAG(dag!).length}`); // 3: Format ← Process ← Seed
})().catch(console.error);
