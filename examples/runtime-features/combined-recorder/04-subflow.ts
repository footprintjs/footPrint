/**
 * Combined Recorder — Narrative Across Subflow Boundary
 *
 * enableNarrative() produces a merged narrative that includes subflow
 * entry/exit markers and per-stage data operations from inside the subflow.
 *
 * Pipeline: Seed → [Subflow: Validate → Charge] → Ship
 *
 * Run: npx tsx examples/runtime-features/combined-recorder/04-subflow.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';

interface State { orderId: string; amount: number; shipped?: boolean }

const paymentSubflow = new FlowChartBuilder()
  .start('Validate', async (scope: any) => { scope.cardValid = scope.amount > 0; }, 'validate')
  .addFunction('Charge', async (scope: any) => { scope.txnId = 'TXN-' + scope.amount; }, 'charge')
  .build();

const chart = flowChart<State>('Seed', async (scope) => {
  scope.orderId = 'ORD-1';
  scope.amount = 99;
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .addFunction('Ship', async (scope) => { scope.shipped = true; }, 'ship')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('Narrative (with subflow entry/exit):');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));

  console.log('\nStructured entries:');
  const entries = executor.getNarrativeEntries();
  for (const e of entries) {
    console.log(`  [${e.type}] depth=${e.depth} ${e.stageName ?? ''}: ${e.text}`);
  }
})().catch(console.error);
