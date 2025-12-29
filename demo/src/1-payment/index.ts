/**
 * Demo 1: Payment Flow (Linear Pattern)
 *
 * Shows the simplest FlowChartBuilder usage - a linear chain of functions.
 */

import { FlowChartBuilder, BaseState } from '@amzn/tree-of-functions';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// Demo data
const cartItems = [
  { id: 1, name: 'Widget', price: 29.99 },
  { id: 2, name: 'Gadget', price: 49.99 },
];

// Stage functions - each receives scope and returns output
const validateCart = async (scope: BaseState) => {
  console.log('  [1] Validating cart...');
  const total = cartItems.reduce((sum, i) => sum + i.price, 0);
  scope.setObject(['pipeline'], 'cartTotal', total);
  return { valid: true, total, itemCount: cartItems.length };
};

const processPayment = async (scope: BaseState) => {
  console.log('  [2] Processing payment...');
  const total = scope.getValue(['pipeline'], 'cartTotal');
  const txId = `TX-${Date.now()}`;
  scope.setObject(['pipeline'], 'transactionId', txId);
  return { success: true, txId, amount: total };
};

const updateInventory = async () => {
  console.log('  [3] Updating inventory...');
  return { updated: cartItems.length };
};

const sendReceipt = async (scope: BaseState) => {
  console.log('  [4] Sending receipt...');
  const txId = scope.getValue(['pipeline'], 'transactionId');
  const total = scope.getValue(['pipeline'], 'cartTotal');
  return { sent: true, txId, total };
};

// Build the payment flow
export function buildPaymentFlow() {
  return new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .addFunction('UpdateInventory', updateInventory)
    .addFunction('SendReceipt', sendReceipt)
    .build();
}

// Execute the demo
async function main() {
  console.log('\n=== Payment Demo (Linear Pattern) ===\n');

  const builder = new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .addFunction('UpdateInventory', updateInventory)
    .addFunction('SendReceipt', sendReceipt);

  const result = await builder.execute(scopeFactory);

  console.log('\n✓ Payment flow complete!');
  console.log('  Final result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
