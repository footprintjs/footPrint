/**
 * Data Recorder — MetricRecorder Across Subflow Boundary
 *
 * Verifies that MetricRecorder tracks reads, writes, and duration
 * for stages inside a subflow. The parent's MetricRecorder should
 * see subflow stages with their subflow-prefixed runtimeStageIds.
 *
 * Pipeline: Seed → [Subflow: Validate → Charge] → Ship
 *
 * Run: npx tsx examples/runtime-features/data-recorder/01-metric-subflow.ts
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
  MetricRecorder,
} from 'footprintjs';

interface OrderState {
  orderId: string;
  amount: number;
  shipped?: boolean;
}

const paymentSubflow = new FlowChartBuilder()
  .start('Validate', async (scope: any) => {
    scope.cardValid = scope.amount > 0;
  }, 'validate')
  .addFunction('Charge', async (scope: any) => {
    scope.txnId = 'TXN-' + scope.amount;
  }, 'charge')
  .build();

const chart = flowChart<OrderState>('Seed', async (scope) => {
  scope.orderId = 'ORD-1';
  scope.amount = 99;
}, 'seed')
  .addSubFlowChartNext('sf-pay', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .addFunction('Ship', async (scope) => {
    scope.shipped = true;
  }, 'ship')
  .build();

(async () => {
  const metrics = new MetricRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(metrics);
  await executor.run();

  console.log('Per-step metrics (keyed by runtimeStageId):');
  for (const [id, m] of metrics.getMap()) {
    console.log(`  ${id}: ${m.stageName} — reads:${m.readCount} writes:${m.writeCount} ${m.duration}ms`);
  }

  const agg = metrics.getMetrics();
  console.log(`\nAggregated: ${agg.totalReads} reads, ${agg.totalWrites} writes, ${agg.totalDuration}ms`);
  console.log(`Stages tracked: ${agg.stageMetrics.size}`);
})().catch(console.error);
