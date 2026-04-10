/**
 * Flowchart: Fork (Parallel Branches)
 *
 * Fork runs multiple branches in parallel, then continues
 * after all branches complete.
 *
 *                +-- CheckInventory --+
 *   LoadOrder ---+                    +-- FinalizeOrder
 *                +-- RunFraudCheck ---+
 * Try it: https://footprintjs.github.io/footprint-playground/samples/fork
 */

import { flowChart,  FlowChartExecutor } from 'footprintjs';

interface Order {
  customerId: string;
  items: string[];
  amount: number;
}

interface ForkState {
  order: Order;
  orderId: string;
  inStock: boolean;
  warehouse: string;
  estimatedShip: string;
  fraudScore: number;
  fraudCleared: boolean;
  fraudFlags: string[];
  orderStatus: string;
}

(async () => {

// -- Mock Services ------------------------------------------------------------

const orderDB = new Map([
  ['ORD-001', { customerId: 'C-42', items: ['Widget A', 'Gadget B'], amount: 250 }],
  ['ORD-002', { customerId: 'C-99', items: ['Premium X'], amount: 5_200 }],
]);

const inventoryService = {
  check: (items: string[]) => ({
    inStock: true,
    warehouse: 'WH-East',
    estimatedShip: '2-3 business days',
  }),
};

const fraudService = {
  evaluate: (amount: number, customerId: string) => ({
    score: amount > 1000 ? 0.72 : 0.05,
    cleared: amount <= 1000,
    flags: amount > 1000 ? ['high-value transaction'] : [],
  }),
};

// -- Flowchart ----------------------------------------------------------------

const chart = flowChart<ForkState>('LoadOrder', async (scope) => {
  const order = orderDB.get('ORD-001')!;
  scope.order = order;
  scope.orderId = 'ORD-001';
}, 'load-order')

  .addListOfFunction([
    {
      id: 'CheckInventory',
      name: 'CheckInventory',
      fn: async (scope) => {
        const order = scope.order;
        await new Promise((r) => setTimeout(r, 30)); // simulate warehouse API
        const result = inventoryService.check(order.items);
        scope.inStock = result.inStock;
        scope.warehouse = result.warehouse;
        scope.estimatedShip = result.estimatedShip;
      },
    },
    {
      id: 'RunFraudCheck',
      name: 'RunFraudCheck',
      fn: async (scope) => {
        const order = scope.order;
        await new Promise((r) => setTimeout(r, 20)); // simulate fraud API
        const result = fraudService.evaluate(order.amount, order.customerId);
        scope.fraudScore = result.score;
        scope.fraudCleared = result.cleared;
        scope.fraudFlags = result.flags;
      },
    },
  ])
  .addFunction('FinalizeOrder', async (scope) => {
    const status = scope.inStock && scope.fraudCleared ? 'confirmed' : 'held-for-review';
    scope.orderStatus = status;
    console.log(`  Order ${scope.orderId}: ${status}`);
  }, 'finalize-order')
  .build();

// -- Run ----------------------------------------------------------------------

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('=== Fork (Parallel Branches) ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
