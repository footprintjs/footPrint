/**
 * Causal Chain — Through Loop Iterations
 *
 * Backtracks from the last loop iteration through previous iterations
 * back to the seed. Each iteration wrote 'counter', and the next
 * iteration read it — creating a chain of dependencies.
 *
 * Pipeline: Init → Increment (loop 3x, $break)
 * Backtrack: increment#3 ← increment#2 ← increment#1 ← Init
 *
 * Run: npx tsx examples/post-execution/causal-chain/04-loop.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { causalChain, flattenCausalDAG, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

interface State { counter: number; target: number }

const chart = flowChart<State>('Init', async (scope) => {
  scope.counter = 0;
  scope.target = 3;
}, 'init')
  .addFunction('Increment', async (scope) => {
    scope.counter += 1;
    if (scope.counter >= scope.target) scope.$break();
  }, 'increment')
  .loopTo('increment')
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const lastIncrement = [...commitLog].reverse().find(c => c.stageId === 'increment')!;

  const dag = causalChain(commitLog, lastIncrement.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  console.log(formatCausalChain(dag!));

  const flat = flattenCausalDAG(dag!);
  console.log(`\nChain length: ${flat.length} (${flat.filter(n => n.stageName === 'Increment').length} Increment iterations + Init)`);
})().catch(console.error);
