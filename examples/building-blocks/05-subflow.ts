/**
 * Flowchart: Subflow (Nested Pipeline)
 *
 * A subflow is a complete flowchart mounted inside another.
 * The parent pipeline runs the subflow as a single stage,
 * then continues after it completes.
 *
 *   Parent:  CreateOrder -> [PaymentSubflow] -> ShipOrder
 *   Subflow: ValidateCard -> ChargeCard -> SendReceipt
 * Try it: https://footprintjs.github.io/footprint-playground/samples/subflow
 */

import { flowChart,  FlowChartBuilder, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface SubflowPaymentState {
  orderTotal: number;
  cardLast4: string;
  cardValid: boolean;
  cardNetwork: string;
  paymentStatus: string;
  transactionId?: string;
  receiptSent: boolean;
}

interface ParentOrderState {
  orderId: string;
  orderTotal: number;
  customerName: string;
  cardLast4: string;
  cardValid?: boolean;
  cardNetwork?: string;
  paymentStatus?: string;
  transactionId?: string;
  receiptSent?: boolean;
  tracking?: string;
  carrier?: string;
  shipmentStatus: string;
}

(async () => {

// -- Mock Services ------------------------------------------------------------

const paymentGateway = {
  validateCard: (last4: string) => ({
    valid: last4.length === 4,
    network: 'Visa',
    expiresAt: '2027-08',
  }),
  charge: (amount: number) => ({
    success: amount < 50_000,
    transactionId: 'TXN-' + Date.now(),
    settledAt: new Date().toISOString(),
  }),
};

const shippingService = {
  createLabel: (orderId: string) => ({
    trackingNumber: 'TRK-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    carrier: 'FedEx',
    estimatedDelivery: '3-5 business days',
  }),
};

// -- Build the Subflow --------------------------------------------------------

const paymentSubflow = new FlowChartBuilder<any, TypedScope<SubflowPaymentState>>()
  .start('ValidateCard', async (scope) => {
    const last4 = scope.cardLast4;
    const result = paymentGateway.validateCard(last4);
    scope.cardValid = result.valid;
    scope.cardNetwork = result.network;
  }, 'validate-card', 'Verify card details with payment gateway')
  .addFunction('ChargeCard', async (scope) => {
    const amount = scope.orderTotal;
    const valid = scope.cardValid;
    if (!valid) {
      scope.paymentStatus = 'failed';
      return;
    }
    await new Promise((r) => setTimeout(r, 40)); // simulate gateway latency
    const result = paymentGateway.charge(amount);
    scope.paymentStatus = result.success ? 'charged' : 'declined';
    scope.transactionId = result.transactionId;
  }, 'charge-card', 'Charge the customer card')
  .addFunction('SendReceipt', async (scope) => {
    const status = scope.paymentStatus;
    const txnId = scope.transactionId;
    scope.receiptSent = status === 'charged';
    if (status === 'charged') {
      console.log(`  Receipt sent for transaction ${txnId}`);
    }
  }, 'send-receipt', 'Email transaction receipt')
  .build();

// -- Build the Parent Flowchart -----------------------------------------------

const chart = flowChart<ParentOrderState>('CreateOrder', async (scope) => {
  scope.orderId = 'ORD-42';
  scope.orderTotal = 129.99;
  scope.customerName = 'Eve';
  scope.cardLast4 = '4242';
}, 'create-order')

  .addSubFlowChartNext('payment', paymentSubflow, 'ProcessPayment', {
    inputMapper: (parentScope: any) => ({
      orderTotal: parentScope.orderTotal,
      cardLast4: parentScope.cardLast4,
    }),
    outputMapper: (subflowOutput: any) => ({
      cardValid: subflowOutput.cardValid,
      cardNetwork: subflowOutput.cardNetwork,
      paymentStatus: subflowOutput.paymentStatus,
      transactionId: subflowOutput.transactionId,
      receiptSent: subflowOutput.receiptSent,
    }),
  })
  .addFunction('ShipOrder', async (scope) => {
    const status = scope.paymentStatus!;
    const orderId = scope.orderId;
    if (status === 'charged') {
      const label = shippingService.createLabel(orderId);
      scope.tracking = label.trackingNumber;
      scope.carrier = label.carrier;
      scope.shipmentStatus = 'shipped';
      console.log(`  ${orderId} shipped via ${label.carrier} -- ${label.trackingNumber}`);
    } else {
      scope.shipmentStatus = 'on-hold';
      console.log(`  ${orderId} on hold -- payment ${status}`);
    }
  }, 'ship-order', 'Create shipping label and dispatch')
  .build();

// -- Run ----------------------------------------------------------------------

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('\n=== Subflow (Nested Pipeline) ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
