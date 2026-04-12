/**
 * Pause/Resume — Pausable Branch Inside a Decider
 *
 * Uses addPausableFunctionBranch to put the pause directly inside
 * the decider's branch. When the decider chooses 'manual', the
 * pausable branch executes and pauses. Low-value orders take the
 * 'auto' branch and skip the pause entirely.
 *
 * Pipeline: Seed → Route(decide) → [manual: Approval(PAUSE)] / [auto: AutoApprove]
 *
 * Run: npx tsx examples/runtime-features/pause-resume/02-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface State {
  amount: number;
  approved?: boolean;
  approver?: string;
}

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    return { question: `Manager: approve $${scope.amount}?` };
  },
  resume: async (scope, input) => {
    const decision = input as { approved: boolean; approver: string };
    scope.approved = decision.approved;
    scope.approver = decision.approver;
  },
};

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 750;
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 500 } }, then: 'manual', label: 'High value' },
    ], 'auto');
  }, 'route')
    .addPausableFunctionBranch('manual', 'ManagerApproval', approvalGate, 'Pause for manager review')
    .addFunctionBranch('auto', 'AutoApprove', async (scope) => {
      scope.approved = true;
      scope.approver = 'auto';
    })
    .setDefault('auto')
    .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  if (executor.isPaused()) {
    console.log('Paused for manager review (high value)');
    await executor.resume(executor.getCheckpoint()!, { approved: true, approver: 'Sarah' });

    const snap = executor.getSnapshot();
    console.log(`Approved: ${snap.sharedState?.approved}, Approver: ${snap.sharedState?.approver}`);
  } else {
    const snap = executor.getSnapshot();
    console.log(`Auto-approved: ${snap.sharedState?.approved}`);
  }

  console.log('Narrative:');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
