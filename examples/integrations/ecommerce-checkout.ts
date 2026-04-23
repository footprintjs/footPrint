/**
 * Use Case: E-commerce Checkout
 *
 * A real checkout flow composes every building block footprintjs offers:
 *   - Fork: inventory + fraud checks run in parallel (shave seconds off p99).
 *   - Decider: route based on combined results (approve / manual-review / reject).
 *   - $break: short-circuit if stock is gone — no sense running fraud.
 *   - decide(): auto-capture WHY each decision was made (audit trail).
 *
 *   ReceiveOrder → [ InventoryCheck ⫴ FraudCheck ] → Decider
 *                                                       ├── reject       → NotifyOutOfStock
 *                                                       ├── manual       → FlagForReview
 *                                                       └── approve      → ChargePayment → FulfillOrder
 *
 * Try it: https://footprintjs.github.io/footprint-playground/samples/ecommerce-checkout
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

// ── Domain types ─────────────────────────────────────────────────────────

interface CheckoutState {
  orderId: string;
  customerId: string;
  items: { sku: string; qty: number; unitPrice: number }[];
  orderTotal: number;
  // filled by parallel checks
  inventoryOk?: boolean;
  outOfStockSkus?: string[];
  fraudScore?: number;
  fraudFlags?: string[];
  // outcome
  decision?: 'approve' | 'manual-review' | 'reject';
  chargeId?: string;
  fulfillmentId?: string;
  status: 'pending' | 'charged' | 'fulfilled' | 'out-of-stock' | 'manual-review';
}

// ── Mock services ────────────────────────────────────────────────────────

const inventoryService = {
  check: async (items: { sku: string; qty: number }[]) => {
    await new Promise((r) => setTimeout(r, 40));
    const missing = items.filter((i) => i.sku === 'WIDGET-OOS').map((i) => i.sku);
    return { ok: missing.length === 0, outOfStock: missing };
  },
};

const fraudService = {
  score: async (customerId: string, amount: number) => {
    await new Promise((r) => setTimeout(r, 60));
    const flags: string[] = [];
    let score = 0.1;
    if (amount > 5000) { score += 0.3; flags.push('high-amount'); }
    if (customerId.startsWith('new-')) { score += 0.2; flags.push('new-customer'); }
    return { score, flags };
  },
};

const paymentGateway = {
  charge: async (amount: number) => {
    await new Promise((r) => setTimeout(r, 30));
    return { chargeId: 'ch_' + Date.now(), amount };
  },
};

const fulfillmentService = {
  create: async (orderId: string) => ({ fulfillmentId: 'ful_' + orderId, dispatchedAt: new Date().toISOString() }),
};

declare const INPUT: { orderId?: string; customerId?: string; items?: { sku: string; qty: number; unitPrice: number }[] } | undefined;

(async () => {
  const chart = flowChart<CheckoutState>('ReceiveOrder', async (scope) => {
    const input = INPUT ?? {};
    scope.orderId = input.orderId ?? 'ORD-' + Date.now();
    scope.customerId = input.customerId ?? 'cust-42';
    scope.items = input.items ?? [
      { sku: 'WIDGET-A', qty: 2, unitPrice: 49.99 },
      { sku: 'GADGET-B', qty: 1, unitPrice: 99.99 },
    ];
    scope.orderTotal = scope.items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
    scope.status = 'pending';
  }, 'receive-order', 'Accept the incoming order and compute the total')

    // ── Fork: inventory + fraud run in parallel ────────────────────────────
    .addFunction('InventoryCheck', async (scope) => {
      const result = await inventoryService.check(scope.items);
      scope.inventoryOk = result.ok;
      scope.outOfStockSkus = result.outOfStock;
    }, 'inventory-check', 'Verify every SKU is in stock')

    .addFunction('FraudCheck', async (scope) => {
      const result = await fraudService.score(scope.customerId, scope.orderTotal);
      scope.fraudScore = result.score;
      scope.fraudFlags = result.flags;
    }, 'fraud-check', 'Score the order for fraud risk')

    // ── Decider: route by combined checks ──────────────────────────────────
    .addDeciderFunction('Classify', (scope) => {
      return decide(scope, [
        { when: (s) => !s.inventoryOk,                  then: 'reject',  label: 'Out of stock' },
        { when: (s) => (s.fraudScore ?? 0) >= 0.5,      then: 'manual',  label: 'High fraud risk' },
        { when: (s) => (s.fraudFlags?.length ?? 0) > 1, then: 'manual',  label: 'Multiple fraud flags' },
      ], 'approve');
    }, 'classify', 'Decide whether to approve, manual-review, or reject')

      .addFunctionBranch('reject', 'NotifyOutOfStock', async (scope) => {
        scope.decision = 'reject';
        scope.status = 'out-of-stock';
        scope.$break();
      }, 'Inform customer the order was rejected')

      .addFunctionBranch('manual', 'FlagForReview', async (scope) => {
        scope.decision = 'manual-review';
        scope.status = 'manual-review';
        scope.$break();
      }, 'Send order to a human reviewer')

      .addFunctionBranch('approve', 'ChargePayment', async (scope) => {
        scope.decision = 'approve';
        const charge = await paymentGateway.charge(scope.orderTotal);
        scope.chargeId = charge.chargeId;
        scope.status = 'charged';
      }, 'Charge the customer')

      .setDefault('approve')
    .end()

    .addFunction('FulfillOrder', async (scope) => {
      if (scope.status !== 'charged') return; // branches that called $break don't reach here
      const fulfillment = await fulfillmentService.create(scope.orderId);
      scope.fulfillmentId = fulfillment.fulfillmentId;
      scope.status = 'fulfilled';
    }, 'fulfill-order', 'Create a fulfillment record and dispatch')
    .build();

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('=== E-commerce Checkout ===\n');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  const { sharedState } = executor.getSnapshot();
  console.log(`\nOrder ${sharedState.orderId}: ${sharedState.status}`);
  console.log(`Decision: ${sharedState.decision}`);
  if (sharedState.chargeId) console.log(`Charge: ${sharedState.chargeId}`);
  if (sharedState.fulfillmentId) console.log(`Fulfillment: ${sharedState.fulfillmentId}`);
})().catch(console.error);
