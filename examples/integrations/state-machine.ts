/**
 * Integration: State Machine + FootPrint
 *
 * Shows how FootPrint complements an existing state machine.
 * Each state handler internally runs a FootPrint flowchart,
 * giving you full causal traces without changing your FSM design.
 *
 * Scenario: Order fulfillment — states flow through
 *   RECEIVED → VALIDATED → PAYMENT_PROCESSED → SHIPPED → DELIVERED
 *
 * Run:  npm run integration:state-machine
 * Try it: https://footprintjs.github.io/footprint-playground/samples/state-machine
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

// ── Domain types ──────────────────────────────────────────────────────

interface Order {
  id: string;
  customer: string;
  items: { name: string; qty: number; price: number }[];
  shippingAddress: string;
}

type OrderState =
  | 'RECEIVED'
  | 'VALIDATED'
  | 'PAYMENT_PROCESSED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'FAILED';

// ── Simple FSM engine ─────────────────────────────────────────────────

type StateHandler = (order: Order, context: Record<string, any>) => Promise<OrderState>;

class OrderStateMachine {
  private handlers = new Map<OrderState, StateHandler>();

  on(state: OrderState, handler: StateHandler) {
    this.handlers.set(state, handler);
    return this;
  }

  async run(order: Order): Promise<{ finalState: OrderState; context: Record<string, any> }> {
    let currentState: OrderState = 'RECEIVED';
    const context: Record<string, any> = {};

    while (this.handlers.has(currentState)) {
      const handler: StateHandler = this.handlers.get(currentState)!;
      console.log(`  [FSM] State: ${currentState}`);
      currentState = await handler(order, context);
    }

    console.log(`  [FSM] Final: ${currentState}`);
    return { finalState: currentState, context };
  }
}

// ── Narrative collection ───────────────────────────────────────────────
// Each flowchart uses recorder(narrative()). After execution, we collect
// the narrative lines from each executor into a combined trace.

const allNarrativeLines: string[] = [];

/** Helper: create an executor, run it, and collect its narrative. */
async function runAndCollect(chart: any): Promise<void> {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  allNarrativeLines.push(...executor.getNarrative());
}

// ── State types for each flowchart ─────────────────────────────────────

interface ValidationState {
  items: { name: string; qty: number; price: number }[];
  allInStock: boolean;
  shippingAddress: string;
  addressValid: boolean;
}

interface PaymentState {
  total: number;
  paymentId: string;
  charged: number;
}

interface ShippingState {
  trackingNumber: string;
  labelAddress: string;
  carrier: string;
  estimatedDays: number;
  dispatchStatus: string;
}

// ── Wire up the FSM with FootPrint-powered handlers ──────────────────
// Each state handler builds and runs a small FootPrint flowchart.
// The FSM controls transitions; FootPrint captures the "why" inside each state.

const fsm = new OrderStateMachine()
  .on('RECEIVED', async (order, context) => {
    // Validation flowchart: check inventory → check address
    let allInStock = false;
    let addressValid = false;

    const chart = flowChart<ValidationState>('CheckInventory', async (scope) => {
      scope.items = order.items;
      allInStock = order.items.every((item) => item.qty <= 100);
      scope.allInStock = allInStock;
    }, 'check-inventory')
      .addFunction('CheckAddress', async (scope) => {
        scope.shippingAddress = order.shippingAddress;
        addressValid = order.shippingAddress.length > 5;
        scope.addressValid = addressValid;
      }, 'check-address')

      .build();

    await runAndCollect(chart);
    context.validation = { allInStock, addressValid };
    return allInStock && addressValid ? 'VALIDATED' : 'FAILED';
  })
  .on('VALIDATED', async (order, context) => {
    // Payment flowchart: calculate total → charge
    let total = 0;
    let paymentId = '';

    const chart = flowChart<PaymentState>('CalculateTotal', async (scope) => {
      total = order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
      scope.total = total;
    }, 'calculate-total')
      .addFunction('ChargePayment', async (scope) => {
        await new Promise((r) => setTimeout(r, 30)); // simulate payment gateway
        paymentId = `PAY-${Date.now()}`;
        scope.paymentId = paymentId;
        scope.charged = total;
      }, 'charge-payment')

      .build();

    await runAndCollect(chart);
    context.payment = { total, paymentId };
    return 'PAYMENT_PROCESSED';
  })
  .on('PAYMENT_PROCESSED', async (order, context) => {
    // Shipping flowchart: create label → dispatch carrier
    let trackingNumber = '';
    let carrier = '';

    const chart = flowChart<ShippingState>('CreateLabel', async (scope) => {
      await new Promise((r) => setTimeout(r, 20)); // simulate label creation
      trackingNumber = `TRK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      scope.trackingNumber = trackingNumber;
      scope.labelAddress = order.shippingAddress;
    }, 'create-label')
      .addFunction('DispatchCarrier', async (scope) => {
        carrier = 'FastShip';
        scope.carrier = carrier;
        scope.estimatedDays = 3;
        scope.dispatchStatus = `Dispatched ${trackingNumber} via ${carrier}`;
      }, 'dispatch-carrier')

      .build();

    await runAndCollect(chart);
    context.shipping = { trackingNumber, carrier };
    return 'SHIPPED';
  })
  .on('SHIPPED', async (_order, context) => {
    // In real life this would be triggered by a webhook
    context.deliveredAt = new Date().toISOString();
    return 'DELIVERED';
  });

// ── Run it ───────────────────────────────────────────────────────────

(async () => {
  const order: Order = {
    id: 'ORD-42',
    customer: 'Alice Chen',
    items: [
      { name: 'Mechanical Keyboard', qty: 1, price: 149.99 },
      { name: 'USB-C Cable', qty: 2, price: 12.99 },
    ],
    shippingAddress: '123 Main St, Portland, OR 97201',
  };

  console.log('=== Order Fulfillment: State Machine + FootPrint ===\n');
  const { finalState, context } = await fsm.run(order);

  console.log('\n--- Result ---');
  console.log('Final state:', finalState);
  console.log('Payment:', context.payment);
  console.log('Shipping:', context.shipping);

  // Print the combined causal trace across ALL flowcharts
  console.log('\n--- Causal Trace (from FootPrint) ---\n');
  allNarrativeLines.forEach((line) => console.log(`  ${line}`));

  console.log('\nThe FSM handled transitions. FootPrint captured the reasoning.');
  console.log('Feed the trace to an LLM to answer: "Why was this order shipped?"');
})().catch(console.error);
