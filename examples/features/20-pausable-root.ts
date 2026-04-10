/**
 * Feature: Pausable Root Stage
 *
 * flowChart() now accepts a PausableHandler as its root stage.
 * This enables single-stage pausable subflows — essential for
 * agent tool execution that needs human-in-the-loop.
 *
 * Before v4.4.1: had to use chart.root.isPausable = true (post-build mutation)
 * After v4.4.1:  flowChart('Name', { execute, resume }, 'id').build()
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

// ── State ───────────────────────────────────────────────────

interface ApprovalState {
  item: string;
  amount: number;
  approved?: boolean;
  result?: string;
}

// ── Pausable handler as root stage ──────────────────────────

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    scope.item = 'Refund REF-123';
    scope.amount = 250;
    // Return data = pause. Return void = continue.
    return { question: `Approve refund of $${scope.amount} for ${scope.item}?` };
  },
  resume: async (scope, input) => {
    const data = input as { approved: boolean };
    scope.approved = data.approved;
    scope.result = data.approved ? 'Refund processed' : 'Refund denied';
  },
};

// ── Build: PausableHandler as root — no post-build mutation ──

const chart = flowChart<ApprovalState>(
  'ApprovalGate',
  approvalGate,
  'approval-gate',
  undefined,
  'Single-stage approval gate with pause/resume',
).build();

// ── Run ─────────────────────────────────────────────────────

(async () => {
const executor = new FlowChartExecutor(chart);
executor.enableNarrative();

await executor.run();
console.log('Paused:', executor.isPaused());

// Simulate human response
const checkpoint = executor.getCheckpoint()!;
await executor.resume(checkpoint, { approved: true });

console.log('Result:', executor.getSnapshot()?.sharedState?.result);
console.log('\nNarrative:');
for (const line of executor.getNarrative()) {
  console.log(' ', line);
}
})().catch(console.error);
