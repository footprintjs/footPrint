/**
 * Break — Inside a Decider Branch
 *
 * $break() inside a decider branch stops execution after the branch.
 * Post-decider stages do NOT run (break is pipeline-wide, unlike
 * subflow-scoped break).
 *
 * Pipeline: Seed → Route(decide) → [abort: AbortStage($break)] / [continue: OK] → Done(skipped)
 *
 * Run: npx tsx examples/runtime-features/break/03-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State { amount: number; aborted?: boolean; doneRan?: boolean }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 0;
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { eq: 0 } }, then: 'abort', label: 'Zero amount' },
    ], 'continue');
  }, 'route')
    .addFunctionBranch('abort', 'AbortStage', async (scope) => {
      scope.aborted = true;
      scope.$break();
    })
    .addFunctionBranch('continue', 'OK', async (scope) => {
      scope.aborted = false;
    })
    .setDefault('continue')
    .end()
  .addFunction('Done', async (scope) => {
    scope.doneRan = true;
  }, 'done')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const snap = executor.getSnapshot();
  console.log(`Aborted: ${snap.sharedState?.aborted}`);
  console.log(`Done ran: ${snap.sharedState?.doneRan ?? false}`);
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
