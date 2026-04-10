/**
 * Feature: Pause/Resume — Human-in-the-Loop Approval
 *
 * Pausable stages stop execution and create a serializable checkpoint.
 * Click "Run" — the pipeline pauses at ManagerApproval.
 * A resume panel appears — edit the JSON and click "Resume" to continue.
 *
 * Use cases:
 * - Manager approval gates (refunds, orders, deployments)
 * - Human review of AI-generated content before publishing
 * - Multi-day workflows that wait for external input
 * - Compliance checks requiring human sign-off
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

// ── State ───────────────────────────────────────────────────

interface RefundState {
  orderId: string;
  customerName: string;
  amount: number;
  reason: string;
  riskLevel?: 'low' | 'medium' | 'high';
  approved?: boolean;
  approver?: string;
  refundId?: string;
  notified?: boolean;
}

// ── Pausable handler ────────────────────────────────────────
// execute: prepares the request, returns pause data
// resume: receives the manager's decision

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    if (scope.amount > 500) scope.riskLevel = 'high';
    else if (scope.amount > 100) scope.riskLevel = 'medium';
    else scope.riskLevel = 'low';

    // Return data = pause. The playground shows this as the pause prompt.
    return {
      question: `Approve $${scope.amount} refund for order ${scope.orderId}?`,
      customerName: scope.customerName,
      reason: scope.reason,
      riskLevel: scope.riskLevel,
    };
  },
  resume: async (scope, input) => {
    const decision = input as { approved: boolean; approver: string };
    scope.approved = decision.approved;
    scope.approver = decision.approver;
  },
};

// ── Build the pipeline ──────────────────────────────────────

const chart = flowChart<RefundState>(
  'ReceiveRequest',
  async (scope) => {
    scope.orderId = 'ORD-2024-7891';
    scope.customerName = 'Sarah Chen';
    scope.amount = 299;
    scope.reason = 'Product arrived damaged — photos attached';
  },
  'receive-request',
  undefined,
  'Receive and validate the refund request',
)
  .addPausableFunction(
    'ManagerApproval',
    approvalGate,
    'manager-approval',
    'Pause for manager review — amount exceeds auto-approve threshold',
  )
  .addFunction(
    'ProcessRefund',
    async (scope) => {
      if (scope.approved) {
        scope.refundId = 'REF-' + Date.now();
        console.log(`Refund ${scope.refundId} issued`);
      } else {
        console.log('Refund denied');
      }
    },
    'process-refund',
    'Issue refund if approved, skip if rejected',
  )
  .addFunction(
    'NotifyCustomer',
    async (scope) => {
      scope.notified = true;
      if (scope.approved) {
        console.log(`Customer ${scope.customerName} notified: refund approved by ${scope.approver}`);
      } else {
        console.log(`Customer ${scope.customerName} notified: refund denied by ${scope.approver}`);
      }
    },
    'notify-customer',
    'Send approval/rejection notification to customer',
  )
  .build();

// ── Run ─────────────────────────────────────────────────────
// The pipeline will pause at ManagerApproval.
// The playground shows a Resume panel — edit the JSON and click Resume.

(async () => {
const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

if (executor.isPaused()) {
  console.log('Pipeline paused. Checkpoint:', JSON.stringify(executor.getCheckpoint()));
}
})().catch(console.error);
