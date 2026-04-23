/**
 * Pause/Resume — Pausable Branch Inside a Selector
 *
 * A selector picks multiple branches to run in parallel. One of them
 * is pausable. After resume, post-selector stages execute.
 *
 * Pipeline: Seed → Triage(select) → [review: HumanReview(PAUSE)] → Done
 * After resume: HumanReview resumes → Done runs
 *
 * Run: npx tsx examples/runtime-features/pause-resume/04-selector-branch.ts
 */

import { flowChart, FlowChartExecutor, select } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface State {
  flags: string[];
  approved?: boolean;
  result?: string;
}

const reviewGate: PausableHandler<any> = {
  execute: async () => {
    return { question: 'Review and approve this item?' };
  },
  resume: async (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
  },
};

const chart = flowChart<State>('Seed', async (scope) => {
  scope.flags = ['needs-review'];
}, 'seed')
  .addSelectorFunction('Triage', (scope) => {
    return select(scope, [
      { when: (s) => s.flags.includes('needs-review'), then: 'review', label: 'Needs review' },
    ]);
  }, 'triage')
    .addPausableFunctionBranch('review', 'HumanReview', reviewGate, 'Wait for human review')
    .end()
  .addFunction('Done', async (scope) => {
    scope.result = scope.approved ? 'reviewed-ok' : 'reviewed-fail';
  }, 'done')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log(`Paused: ${executor.isPaused()}`);

  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;
    console.log(`Invoker: ${checkpoint.invokerStageId}`);
    console.log(`Continuation: ${checkpoint.continuationStageId}`);

    await executor.resume(checkpoint, { approved: true });

    const snap = executor.getSnapshot();
    console.log(`Result: ${snap.sharedState?.result}`); // 'reviewed-ok'
  }

  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
