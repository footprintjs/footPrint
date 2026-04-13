/**
 * Pause/Resume — Decider Branch Pause With No Post-Decider Stages
 *
 * Edge case: the decider is the last stage in the pipeline. After resume,
 * there's nowhere to continue — execution terminates cleanly.
 *
 * Tests that the engine doesn't crash when continuationStageId is undefined.
 *
 * Pipeline: Seed → Route(decide) → [review: Approval(PAUSE)]
 * After resume: Approval resumes → pipeline ends (no Done stage)
 *
 * Run: npx tsx examples/runtime-features/pause-resume/05-no-continuation.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface State {
  amount: number;
  approved?: boolean;
}

const approvalGate: PausableHandler<any> = {
  execute: async (scope) => {
    return { question: `Approve $${scope.amount}?` };
  },
  resume: async (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
  },
};

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 100;
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 0 } }, then: 'review', label: 'Any amount' },
    ], 'review');
  }, 'route')
    .addPausableFunctionBranch('review', 'Approval', approvalGate)
    .end()
  // No post-decider stages — pipeline ends after the decider
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log(`Paused: ${executor.isPaused()}`);

  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;
    console.log(`Continuation: ${checkpoint.continuationStageId ?? 'none (pipeline ends)'}`);

    await executor.resume(checkpoint, { approved: true });

    const snap = executor.getSnapshot();
    console.log(`Approved: ${snap.sharedState?.approved}`);
    console.log('Pipeline completed cleanly (no crash)');
  }

  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
