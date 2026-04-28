/**
 * Feature: Subflow Manifest — Lightweight catalog for LLM navigation.
 *
 * ManifestFlowRecorder builds a tree of subflow IDs + descriptions
 * as a side effect of traversal. An LLM receiving a snapshot can:
 *   1. Read the manifest to understand which subflows exist
 *   2. Pull full specs on demand for any subflow it wants to explore
 *
 * Run:  npm run feature:manifest
 * Try it: https://footprintjs.github.io/footprint-playground/samples/subflow-manifest
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
  ManifestFlowRecorder,
  type TypedScope,
} from 'footprintjs';
import type { ManifestEntry } from 'footprintjs';

interface OrderState {
  orderId: string;
  amount: number;
  cardLast4: string;
  cardValid?: boolean;
  charged?: boolean;
  txnId?: string;
  inStock?: boolean;
  warehouse?: string;
  reserved?: boolean;
  reservationId?: string;
  shipped?: boolean;
}

type Scope = TypedScope<OrderState>;

(async () => {

// ── Build Subflows ────────────────────────────────────────────────────

const paymentSubflow = new FlowChartBuilder<any, Scope>()
  .start('ValidateCard', async (scope) => {
    scope.cardValid = scope.cardLast4.length === 4;
  }, 'validate-card', 'Verify card details')
  .addFunction('ChargeCard', async (scope) => {
    scope.charged = scope.amount < 10_000;
    scope.txnId = 'TXN-' + Date.now();
  }, 'charge-card', 'Charge the card')
  .build();

const inventorySubflow = new FlowChartBuilder<any, Scope>()
  .start('CheckInventory', async (scope) => {
    scope.inStock = true;
    scope.warehouse = 'WH-West';
  }, 'check-inventory', 'Look up warehouse stock')
  .addFunction('ReserveStock', async (scope) => {
    scope.reserved = true;
    scope.reservationId = `RSV-${scope.warehouse}-${Date.now()}`;
  }, 'reserve-stock', 'Reserve units')
  .build();

// ── Build Parent Flowchart ────────────────────────────────────────────

const chart = flowChart<OrderState>('ReceiveOrder', async (scope) => {
  scope.orderId = 'ORD-100';
  scope.amount = 249.99;
  scope.cardLast4 = '1234';
}, 'receive-order', undefined, 'Ingest order and customer data')

  .addSubFlowChartNext('sf-payment', paymentSubflow, 'Payment', {
    inputMapper: (s: any) => ({ amount: s.amount, cardLast4: s.cardLast4 }),
  })
  .addSubFlowChartNext('sf-inventory', inventorySubflow, 'Inventory')
  .addFunction('ShipOrder', async (scope) => {
    scope.shipped = true;
  }, 'ship-order', 'Dispatch shipment')
  .build();

// ── Execute with ManifestFlowRecorder ─────────────────────────────────

const executor = new FlowChartExecutor(chart);
const manifest = new ManifestFlowRecorder();
executor.attachFlowRecorder(manifest);

await executor.run();

// ── Print manifest tree ───────────────────────────────────────────────

console.log('=== Subflow Manifest ===\n');

function printManifest(entries: ManifestEntry[], indent = 0) {
  for (const entry of entries) {
    const pad = '  '.repeat(indent);
    const desc = entry.description ? ` -- ${entry.description}` : '';
    console.log(`${pad}  [${entry.subflowId}] ${entry.name}${desc}`);
    if (entry.children.length > 0) {
      printManifest(entry.children, indent + 1);
    }
  }
}

printManifest(manifest.getManifest());

console.log('\n=== Narrative ===\n');
for (const line of executor.getNarrativeEntries().map(e => e.text)) {
  console.log(`  ${line}`);
}

})().catch(console.error);
