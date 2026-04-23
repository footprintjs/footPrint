/**
 * Break — Inside a Subflow
 *
 * $break() inside a subflow stops the SUBFLOW only — the parent
 * pipeline continues with the next stage after the subflow mount.
 * This is the expected behavior: subflows have their own execution
 * scope, and break is scoped to the current traversal.
 *
 * Pipeline: Seed → [Subflow: Step1 → Step2($break) → Step3(skipped)] → PostSubflow
 *
 * Run: npx tsx examples/runtime-features/break/02-subflow.ts
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
} from 'footprintjs';

interface ParentState {
  started: boolean;
  postSubflowRan?: boolean;
}

const subflow = new FlowChartBuilder()
  .start('Step1', async (scope: any) => {
    scope.step1 = true;
  }, 'step1')
  .addFunction('Step2', async (scope: any) => {
    scope.step2 = true;
    scope.$break(); // stops subflow here
  }, 'step2')
  .addFunction('Step3', async (scope: any) => {
    scope.step3 = true; // should NOT execute
  }, 'step3')
  .build();

const chart = flowChart<ParentState>('Seed', async (scope) => {
  scope.started = true;
}, 'seed')
  .addSubFlowChartNext('sf-inner', subflow, 'InnerFlow')
  .addFunction('PostSubflow', async (scope) => {
    scope.postSubflowRan = true; // SHOULD execute — break is scoped to subflow
  }, 'post-subflow')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const snap = executor.getSnapshot();
  console.log(`Post-subflow ran: ${snap.sharedState?.postSubflowRan}`);
  console.log('Narrative:');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
