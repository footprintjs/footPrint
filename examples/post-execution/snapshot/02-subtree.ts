/**
 * Snapshot — Subflow Subtree Drill-Down
 *
 * getSubtreeSnapshot() extracts the execution tree for a specific
 * subflow. listSubflowPaths() returns all mounted subflow IDs.
 *
 * Run: npx tsx examples/post-execution/snapshot/02-subtree.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor, getSubtreeSnapshot, listSubflowPaths } from 'footprintjs';

interface State { orderId: string; amount: number }

const paymentSubflow = new FlowChartBuilder()
  .start('Validate', async (scope: any) => { scope.valid = true; }, 'validate')
  .addFunction('Charge', async (scope: any) => { scope.txnId = 'TXN-1'; }, 'charge')
  .build();

const chart = flowChart<State>('Seed', async (scope) => {
  scope.orderId = 'ORD-1';
  scope.amount = 99;
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();

  const snap = executor.getSnapshot();

  const paths = listSubflowPaths(snap);
  console.log('Subflow paths:', paths);

  const subtree = getSubtreeSnapshot(snap, 'sf-pay');
  if (subtree) {
    console.log(`Subflow ID: ${subtree.subflowId}`);
    console.log(`Root stage: ${subtree.executionTree.name}`);
  }
})().catch(console.error);
