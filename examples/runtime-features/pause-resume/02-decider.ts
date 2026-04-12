/**
 * Pause/Resume — Conditional Pause After Decider
 *
 * The decider routes to 'high' or 'low'. A pausable stage after the
 * decider conditionally pauses based on the chosen tier. This pattern
 * works because execute() can return void (no pause) or data (pause).
 *
 * High-value: pauses for manager review.
 * Low-value: auto-approves (execute returns void → no pause).
 *
 * Pipeline: Seed → Route(decide) → Approval(conditional PAUSE) → Done
 *
 * Run: npx tsx examples/runtime-features/pause-resume/02-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface State {
  amount: number;
  tier?: string;
  approved?: boolean;
  result?: string;
}

const conditionalApproval: PausableHandler<any> = {
  execute: async (scope) => {
    if (scope.tier === 'high') {
      return { question: `Manager: approve $${scope.amount}?` };
    }
    // Low tier → auto-approve, no pause
    scope.approved = true;
  },
  resume: async (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
  },
};

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 750; // Change to 50 to test auto-approve path
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 500 } }, then: 'high', label: 'High value' },
    ], 'low');
  }, 'route')
    .addFunctionBranch('high', 'HighPath', async (scope) => {
      scope.tier = 'high';
    })
    .addFunctionBranch('low', 'LowPath', async (scope) => {
      scope.tier = 'low';
    })
    .setDefault('low')
    .end()
  .addPausableFunction('Approval', conditionalApproval, 'approval')
  .addFunction('Done', async (scope) => {
    scope.result = scope.approved ? 'processed' : 'rejected';
  }, 'done')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  if (executor.isPaused()) {
    console.log('Paused for manager review (high value)');
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    console.log('Resumed → result:', executor.getSnapshot().sharedState?.result);
  } else {
    console.log('Auto-approved (low value) → result:', executor.getSnapshot().sharedState?.result);
  }

  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
