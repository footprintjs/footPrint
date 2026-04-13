/**
 * Flow Recorder — Subflow Entry/Exit Events
 *
 * A custom FlowRecorder observing onSubflowEntry and onSubflowExit
 * events. These fire when execution enters and exits a subflow.
 *
 * Pipeline: Seed → [Subflow: Validate → Charge] → Ship
 *
 * Run: npx tsx examples/runtime-features/flow-recorder/04-subflow-events.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder, FlowSubflowEvent } from 'footprintjs';

interface State { orderId: string; shipped?: boolean }

const paymentSubflow = new FlowChartBuilder()
  .start('Validate', async (scope: any) => { scope.valid = true; }, 'validate')
  .addFunction('Charge', async (scope: any) => { scope.txnId = 'TXN-1'; }, 'charge')
  .build();

const chart = flowChart<State>('Seed', async (scope) => {
  scope.orderId = 'ORD-1';
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment')
  .addFunction('Ship', async (scope) => { scope.shipped = true; }, 'ship')
  .build();

(async () => {
  const entries: string[] = [];

  const observer: FlowRecorder = {
    id: 'subflow-observer',
    onSubflowEntry(event: FlowSubflowEvent) {
      entries.push(`→ Entered ${event.name} (${event.subflowId})`);
    },
    onSubflowExit(event: FlowSubflowEvent) {
      entries.push(`← Exited ${event.name} (${event.subflowId})`);
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(observer);
  await executor.run();

  console.log('Subflow events:');
  entries.forEach((e) => console.log(`  ${e}`));
})().catch(console.error);
