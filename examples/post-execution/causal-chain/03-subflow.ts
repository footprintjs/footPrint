/**
 * Causal Chain — Through a Subflow Boundary
 *
 * Backtracks from a parent stage to the subflow that wrote the value it read.
 * The subflow's outputMapper copies txnId back to the parent, so the parent's
 * commit log records that write on the mount (Payment). The inner stages
 * (Validate, Charge) commit to the subflow's own log, not the parent's, so the
 * parent chain ends at the mount.
 *
 * Pipeline: Seed → [Subflow: Validate → Charge] → Ship
 * Backtrack from Ship: Ship ← Payment (wrote txnId)
 *
 * Run: npx tsx examples/post-execution/causal-chain/03-subflow.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import { QualityRecorder } from 'footprintjs/trace';
import { causalChain, flattenCausalDAG, formatCausalChain } from 'foottrace';

interface State { orderId: string; amount: number; txnId?: string; shipped?: boolean }

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
    outputMapper: (out: any) => ({ txnId: out.txnId }),
  })
  .addFunction('Ship', async (scope) => {
    scope.shipped = scope.txnId !== undefined;
  }, 'ship')
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachScopeRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const shipCommit = commitLog.find(c => c.stageId === 'ship')!;

  const dag = causalChain(commitLog, shipCommit.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  if (dag) {
    console.log(formatCausalChain(dag));
    console.log(`\nCausal chain depth: ${flattenCausalDAG(dag).length} nodes`);
  }
})().catch(console.error);
