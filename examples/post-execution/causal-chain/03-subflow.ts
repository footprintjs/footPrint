/**
 * Causal Chain — Through a Subflow Boundary
 *
 * Backtracks from a parent stage through data written by a subflow
 * stage. Shows that causal chains cross subflow boundaries correctly.
 *
 * Pipeline: Seed → [Subflow: Validate → Charge] → Ship
 * Backtrack from Ship: Ship ← Charge (wrote txnId) ← Validate ← Seed
 *
 * Run: npx tsx examples/post-execution/causal-chain/03-subflow.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import { causalChain, flattenCausalDAG, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

interface State { orderId: string; amount: number; shipped?: boolean }

const paymentSubflow = new FlowChartBuilder()
  .start('Validate', async (scope: any) => {
    scope.cardValid = scope.amount > 0;
  }, 'validate')
  .addFunction('Charge', async (scope: any) => {
    scope.txnId = 'TXN-' + scope.amount;
  }, 'charge')
  .build();

const chart = flowChart<State>('Seed', async (scope) => {
  scope.orderId = 'ORD-1';
  scope.amount = 99;
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .addFunction('Ship', async (scope) => {
    scope.shipped = true;
  }, 'ship')
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const shipCommit = commitLog.find(c => c.stageId === 'ship')!;

  const dag = causalChain(commitLog, shipCommit.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  if (dag) {
    console.log(formatCausalChain(dag));
    console.log(`\nCausal chain depth: ${flattenCausalDAG(dag).length} nodes`);
  }
})().catch(console.error);
