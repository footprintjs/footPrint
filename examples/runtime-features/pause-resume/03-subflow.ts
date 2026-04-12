/**
 * Pause/Resume — Pause Inside a Subflow
 *
 * The pausable stage is inside a nested subflow. Verifies that:
 * 1. The pause propagates up to the parent executor
 * 2. The checkpoint captures the subflow's position
 * 3. Resume continues from inside the subflow
 * 4. Post-subflow stages in the parent still execute after resume
 *
 * Pipeline: Seed → [Subflow: Validate → Approval(PAUSE) → Charge] → Ship
 *
 * Run: npx tsx examples/runtime-features/pause-resume/03-subflow.ts
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
} from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface ParentState {
  orderId: string;
  amount: number;
  shipped?: boolean;
}

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    return { question: `Approve payment of $${scope.amount}?` };
  },
  resume: async (scope, input) => {
    scope.paymentApproved = (input as { approved: boolean }).approved;
  },
};

const paymentSubflow = new FlowChartBuilder()
  .start('ValidateCard', async (scope: any) => {
    scope.cardValid = true;
  }, 'validate-card')
  .addPausableFunction('ApprovePayment', approvalGate, 'approve-payment')
  .addFunction('ChargeCard', async (scope: any) => {
    scope.txnId = scope.paymentApproved ? 'TXN-OK' : 'TXN-DECLINED';
  }, 'charge')
  .build();

const chart = flowChart<ParentState>('Seed', async (scope) => {
  scope.orderId = 'ORD-99';
  scope.amount = 149;
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .addFunction('Ship', async (scope) => {
    scope.shipped = true;
  }, 'ship')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log(`Paused (inside subflow): ${executor.isPaused()}`);

  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;
    await executor.resume(checkpoint, { approved: true });

    const snap = executor.getSnapshot();
    console.log(`Shipped: ${snap.sharedState?.shipped}`);
    console.log('Narrative (spans subflow + pause boundary):');
    executor.getNarrative().forEach((line) => console.log(`  ${line}`));
  }
})().catch(console.error);
