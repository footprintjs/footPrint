/**
 * Narrative Query — getNarrative(), getNarrativeEntries(), getFlowNarrative()
 *
 * Three ways to read the auto-generated narrative after execution.
 *
 * Run: npx tsx examples/post-execution/narrative-query/01-get-narrative.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State { amount: number; tier?: string; status?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 250;
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 100 } }, then: 'express', label: 'High value' },
    ], 'standard');
  }, 'route')
    .addFunctionBranch('express', 'Express', async (scope) => { scope.status = 'express'; })
    .addFunctionBranch('standard', 'Standard', async (scope) => { scope.status = 'standard'; })
    .setDefault('standard')
    .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  // 1. String array — for display
  console.log('=== getNarrative() ===');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));

  // 2. Structured entries — for programmatic access
  console.log('\n=== getNarrativeEntries() ===');
  for (const e of executor.getNarrativeEntries()) {
    console.log(`  [${e.type}] depth=${e.depth} ${e.stageName ?? ''}`);
  }

  // 3. Flow-only narrative — control flow without data ops
  console.log('\n=== getFlowNarrative() ===');
  executor.getFlowNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
