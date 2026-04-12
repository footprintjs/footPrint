/**
 * Pause/Resume — Linear Pipeline
 *
 * A pausable stage stops execution and creates a JSON-serializable
 * checkpoint. Later, resume() continues from where it left off.
 *
 * Pipeline: ReceiveRequest → ManagerApproval (PAUSE) → ProcessRefund → Notify
 *
 * Run: npx tsx examples/runtime-features/pause-resume/01-linear.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface RefundState {
  orderId: string;
  amount: number;
  approved?: boolean;
  approver?: string;
  refundId?: string;
}

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    return { question: `Approve $${scope.amount} refund for ${scope.orderId}?` };
  },
  resume: async (scope, input) => {
    const decision = input as { approved: boolean; approver: string };
    scope.approved = decision.approved;
    scope.approver = decision.approver;
  },
};

const chart = flowChart<RefundState>('ReceiveRequest', async (scope) => {
  scope.orderId = 'ORD-42';
  scope.amount = 299;
}, 'receive')
  .addPausableFunction('ManagerApproval', approvalGate, 'approval')
  .addFunction('ProcessRefund', async (scope) => {
    scope.refundId = scope.approved ? 'REF-' + Date.now() : undefined;
  }, 'process')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log(`Paused: ${executor.isPaused()}`);

  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;
    console.log('Checkpoint created (JSON-safe)');

    await executor.resume(checkpoint, { approved: true, approver: 'Sarah' });
    console.log(`Refund ID: ${executor.getSnapshot().sharedState?.refundId}`);
  }

  console.log('Narrative (spans pause boundary):');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
