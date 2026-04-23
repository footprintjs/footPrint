/**
 * Pause/Resume — Pausable Branch Inside a Decider
 *
 * addPausableFunctionBranch puts the pause directly inside the decider's
 * branch. After resume, execution continues to post-decider stages.
 *
 * This tests the invoker context fix: the checkpoint carries
 * continuationStageId (the decider's next node), so resume() knows
 * where to continue after the branch completes.
 *
 * Pipeline: Seed → Route(decide) → [manual: Approval(PAUSE)] / [auto: Auto] → Done
 * After resume: Approval resumes → Done runs (result = 'processed')
 *
 * Run: npx tsx examples/runtime-features/pause-resume/02-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface State {
  amount: number;
  approved?: boolean;
  approver?: string;
  result?: string;
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
    .addPausableFunctionBranch('manual', 'ManagerApproval', approvalGate, 'Pause for manager')
    .addFunctionBranch('auto', 'AutoApprove', async (scope) => {
      scope.approved = true;
      scope.approver = 'auto';
    })
    .setDefault('auto')
    .end()
  .addFunction('Done', async (scope) => {
    scope.result = scope.approved ? 'processed' : 'rejected';
  }, 'done')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log(`Paused: ${executor.isPaused()}`);

  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;

    // Checkpoint carries invoker context (collected during traversal)
    console.log(`Invoker: ${checkpoint.invokerStageId}`);       // 'route'
    console.log(`Continuation: ${checkpoint.continuationStageId}`); // 'done'

    await executor.resume(checkpoint, { approved: true, approver: 'Sarah' });

    const snap = executor.getSnapshot();
    console.log(`Approved: ${snap.sharedState?.approved}`);
    console.log(`Approver: ${snap.sharedState?.approver}`);
    console.log(`Result: ${snap.sharedState?.result}`); // 'processed' — Done ran!
  }

  console.log('\nNarrative (spans pause boundary):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
