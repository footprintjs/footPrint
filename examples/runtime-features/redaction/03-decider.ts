/**
 * Redaction — Inside Decider Branches
 *
 * Redaction policy applies to all branches equally. Sensitive keys
 * written in the chosen branch appear as [REDACTED] in narrative.
 *
 * Pipeline: Seed → Route(decide) → [premium: WriteSSN] / [standard: NoSSN]
 *
 * Run: npx tsx examples/runtime-features/redaction/03-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State { tier: string; ssn?: string; result?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.tier = 'premium';
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { tier: { eq: 'premium' } }, then: 'premium', label: 'Premium' },
    ], 'standard');
  }, 'route')
    .addFunctionBranch('premium', 'PremiumPath', async (scope) => {
      scope.ssn = '999-88-7777';
      scope.result = 'premium-processed';
    })
    .addFunctionBranch('standard', 'StandardPath', async (scope) => {
      scope.result = 'standard-processed';
    })
    .setDefault('standard')
    .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({ keys: ['ssn'] });
  executor.enableNarrative();
  await executor.run();

  console.log('Narrative (ssn redacted in premium branch):');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));

  const report = executor.getRedactionReport();
  console.log(`\nRedacted keys: ${report.redactedKeys.join(', ')}`);
})().catch(console.error);
