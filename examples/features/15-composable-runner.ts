/**
 * Feature: ComposableRunner — Mount runners as subflows for UI drill-down.
 *
 * ComposableRunner is an interface for runners that expose their internal
 * flowChart via toFlowChart(). When mounted as a subflow, the parent's
 * snapshot contains the child's full execution tree.
 *
 * Run:  npm run feature:composable
 * Try it: https://footprintjs.github.io/footprint-playground/samples/composable-runner
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
  getSubtreeSnapshot,
  ManifestFlowRecorder,
  type TypedScope,
} from 'footprintjs';
import type { ComposableRunner, FlowChart, RunOptions } from 'footprintjs';

// ── State types ─────────────────────────────────────────────────────────

interface PaymentState {
  amount: number;
  cardValid?: boolean;
  txnId?: string;
  charged?: number;
}

interface InventoryState {
  orderId?: string;
  warehouse?: string;
  inStock?: boolean;
  reservationId?: string;
}

interface OrderState {
  orderId: string;
  amount: number;
  confirmed?: boolean;
}

// ── 1. ComposableRunner implementations ─────────────────────────────────

class PaymentProcessor implements ComposableRunner<{ amount: number }, { txnId: string }> {
  private chart: FlowChart;

  constructor() {
    this.chart = new FlowChartBuilder<any, TypedScope<PaymentState>>()
      .start('ValidateCard', (scope) => {
        scope.cardValid = scope.amount > 0 && scope.amount < 10_000;
      }, 'validate-card', 'Verify card details and limits')
      .addFunction('ChargeCard', (scope) => {
        scope.txnId = `TXN-${Date.now()}`;
        scope.charged = scope.amount;
      }, 'charge-card', 'Process the charge')
      .build();
  }

  toFlowChart(): FlowChart { return this.chart; }

  async run(input: { amount: number }, options?: RunOptions): Promise<{ txnId: string }> {
    const executor = new FlowChartExecutor(this.chart);
    await executor.run({ input, ...options });
    const snap = executor.getSnapshot();
    return { txnId: (snap?.sharedState?.txnId as string) ?? 'unknown' };
  }
}

class InventoryChecker implements ComposableRunner<{ orderId: string }, { inStock: boolean }> {
  private chart: FlowChart;

  constructor() {
    this.chart = new FlowChartBuilder<any, TypedScope<InventoryState>>()
      .start('CheckWarehouse', (scope) => {
        scope.warehouse = 'WH-West';
        scope.inStock = true;
      }, 'check-warehouse', 'Look up warehouse availability')
      .addFunction('ReserveStock', (scope) => {
        scope.reservationId = `RSV-${scope.warehouse}-${Date.now()}`;
      }, 'reserve-stock', 'Reserve units for this order')
      .build();
  }

  toFlowChart(): FlowChart { return this.chart; }

  async run(input: { orderId: string }, options?: RunOptions): Promise<{ inStock: boolean }> {
    const executor = new FlowChartExecutor(this.chart);
    await executor.run({ input, ...options });
    const snap = executor.getSnapshot();
    return { inStock: (snap?.sharedState?.inStock as boolean) ?? false };
  }
}

// ── 2. Mount as subflows in parent ──────────────────────────────────────

(async () => {

const payment = new PaymentProcessor();
const inventory = new InventoryChecker();

const orderChart = flowChart<OrderState>('ReceiveOrder', (scope) => {
  scope.orderId = 'ORD-42';
  scope.amount = 149.99;
}, 'receive-order', undefined, 'Ingest order data')
  .addSubFlowChartNext('sf-payment', payment.toFlowChart(), 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount }),
  })
  .addSubFlowChartNext('sf-inventory', inventory.toFlowChart(), 'Inventory')
  .addFunction('Confirm', (scope) => { scope.confirmed = true; }, 'confirm', 'Send confirmation')

  .build();

const executor = new FlowChartExecutor(orderChart);
const manifest = new ManifestFlowRecorder();
executor.attachFlowRecorder(manifest);

await executor.run();
const snapshot = executor.getSnapshot();

// ── 3. Results ──────────────────────────────────────────────────────────

console.log('=== Full Order Narrative ===\n');
for (const line of executor.getNarrative()) {
  console.log(`  ${line}`);
}

console.log('\n=== Subflow Manifest ===\n');
for (const entry of manifest.getManifest()) {
  console.log(`  [${entry.subflowId}] ${entry.name}`);
}

console.log('\n=== Drill-down: Payment Subtree ===\n');
const paymentSubtree = getSubtreeSnapshot(snapshot, 'sf-payment');
if (paymentSubtree) {
  console.log(`  Subflow ID: ${paymentSubtree.subflowId}`);
  console.log(`  Tree root: ${paymentSubtree.executionTree.name}`);
}

console.log('\n=== Top-level State ===\n');
for (const [key, value] of Object.entries(snapshot.sharedState)) {
  console.log(`  ${key}: ${JSON.stringify(value)}`);
}

})().catch(console.error);
