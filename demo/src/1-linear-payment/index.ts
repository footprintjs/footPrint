/**
 * Demo 1: Linear Flow (Payment Domain)
 *
 * WHY: This is the simplest possible pipeline pattern - a linear chain of stages.
 * Understanding this pattern is essential before tackling branching, parallel,
 * or composition patterns. It demonstrates the core concepts:
 * - Building a pipeline with FlowChartBuilder
 * - Executing stages in sequence
 * - Sharing state between stages via scope operations
 *
 * PATTERN: Linear chain - A → B → C → D
 * Each stage executes after the previous one completes.
 *
 * BUILDS ON: Nothing - this is the foundation
 *
 * KEY CONCEPTS:
 * - start(): Defines the entry point stage
 * - addFunction(): Chains subsequent stages
 * - scope.setObject(): Writes data to scope (buffered until commit)
 * - scope.getValue(): Reads data from scope
 * - Scope path ['pipeline']: Standard namespace for pipeline-level data
 *
 * DOMAIN: Payment Processing
 * A typical e-commerce payment flow:
 * 1. ValidateCart - Verify cart contents and calculate total
 * 2. ProcessPayment - Charge the payment method
 * 3. UpdateInventory - Decrement stock for purchased items
 * 4. SendReceipt - Email confirmation to customer
 */

import { FlowChartBuilder, BaseState } from 'footprint';

// ============================================================================
// Scope Factory
// ============================================================================

/**
 * Creates a scope instance for each stage.
 *
 * WHY: The scope factory is called before each stage executes, providing
 * the stage with access to shared state. BaseState is the standard
 * implementation that provides getValue/setObject/commit operations.
 *
 * DESIGN: We use a simple factory that creates BaseState instances.
 * In production, you might add recorders for metrics/debugging.
 */
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// Domain Data
// ============================================================================

/**
 * Sample cart items for the demo.
 *
 * WHY: Realistic domain data makes the demo more understandable
 * and demonstrates how real-world data flows through the pipeline.
 */
interface CartItem {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

const cartItems: CartItem[] = [
  { id: 1, name: 'Wireless Mouse', price: 29.99, quantity: 1 },
  { id: 2, name: 'USB-C Hub', price: 49.99, quantity: 2 },
  { id: 3, name: 'Laptop Stand', price: 79.99, quantity: 1 },
];

// ============================================================================
// Stage Functions
// ============================================================================

/**
 * Stage 1: Validate the shopping cart.
 *
 * WHY: First stage validates input and calculates derived values.
 * This pattern of "validate and enrich" is common in pipelines.
 *
 * SCOPE OPERATIONS:
 * - setObject(['pipeline'], 'cartTotal', total): Stores calculated total
 * - setObject(['pipeline'], 'itemCount', count): Stores item count
 *
 * These values are available to subsequent stages via getValue().
 */
const validateCart = async (scope: BaseState) => {
  console.log('  [1] ValidateCart: Validating cart contents...');

  // Calculate cart total
  const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  // Store in scope for subsequent stages
  // WHY: Using scope.setObject() makes data available to later stages
  // The path ['pipeline'] is a standard namespace for pipeline-level data
  scope.setObject(['pipeline'], 'cartTotal', total);
  scope.setObject(['pipeline'], 'itemCount', itemCount);
  scope.setObject(['pipeline'], 'cartItems', cartItems);

  console.log(`      Cart validated: ${itemCount} items, $${total.toFixed(2)} total`);

  // Return value becomes the stage output (available in traversal extractors)
  return {
    valid: true,
    total,
    itemCount,
    items: cartItems.map((i) => i.name),
  };
};

/**
 * Stage 2: Process the payment.
 *
 * WHY: Demonstrates reading values written by previous stages.
 * This is the core pattern for stage-to-stage communication.
 *
 * SCOPE OPERATIONS:
 * - getValue(['pipeline'], 'cartTotal'): Reads total from previous stage
 * - setObject(['pipeline'], 'transactionId', txId): Stores new value
 */
const processPayment = async (scope: BaseState) => {
  console.log('  [2] ProcessPayment: Processing payment...');

  // Read value written by previous stage
  // WHY: getValue() retrieves data stored by earlier stages
  const total = scope.getValue(['pipeline'], 'cartTotal') as number;

  // Simulate payment processing
  const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Store transaction ID for later stages
  scope.setObject(['pipeline'], 'transactionId', transactionId);
  scope.setObject(['pipeline'], 'paymentStatus', 'completed');

  console.log(`      Payment processed: $${total.toFixed(2)}, Transaction: ${transactionId}`);

  return {
    success: true,
    transactionId,
    amount: total,
    timestamp: new Date().toISOString(),
  };
};

/**
 * Stage 3: Update inventory.
 *
 * WHY: Demonstrates a stage that reads from scope but doesn't need
 * to write new values. Not every stage needs to modify scope.
 *
 * SCOPE OPERATIONS:
 * - getValue(['pipeline'], 'cartItems'): Reads items to update inventory
 */
const updateInventory = async (scope: BaseState) => {
  console.log('  [3] UpdateInventory: Updating inventory levels...');

  // Read cart items from scope
  const items = scope.getValue(['pipeline'], 'cartItems') as CartItem[];

  // Simulate inventory update
  const updatedItems = items.map((item) => ({
    id: item.id,
    name: item.name,
    quantityReduced: item.quantity,
  }));

  console.log(`      Inventory updated for ${items.length} products`);

  return {
    updated: true,
    itemsUpdated: updatedItems,
  };
};

/**
 * Stage 4: Send receipt to customer.
 *
 * WHY: Final stage that aggregates data from multiple previous stages.
 * Demonstrates reading multiple scope values.
 *
 * SCOPE OPERATIONS:
 * - getValue(['pipeline'], 'transactionId'): From ProcessPayment
 * - getValue(['pipeline'], 'cartTotal'): From ValidateCart
 * - getValue(['pipeline'], 'itemCount'): From ValidateCart
 */
const sendReceipt = async (scope: BaseState) => {
  console.log('  [4] SendReceipt: Sending receipt email...');

  // Read values from multiple previous stages
  const transactionId = scope.getValue(['pipeline'], 'transactionId') as string;
  const total = scope.getValue(['pipeline'], 'cartTotal') as number;
  const itemCount = scope.getValue(['pipeline'], 'itemCount') as number;

  // Simulate sending receipt
  const receiptId = `RCP-${transactionId.slice(4)}`;

  console.log(`      Receipt sent: ${receiptId} for ${itemCount} items ($${total.toFixed(2)})`);

  return {
    sent: true,
    receiptId,
    transactionId,
    total,
    itemCount,
    sentAt: new Date().toISOString(),
  };
};

// ============================================================================
// Flow Builder
// ============================================================================

/**
 * Builds the payment flow pipeline.
 *
 * WHY: Exported for testing. Tests can call buildPaymentFlow() to get
 * the same pipeline configuration used in the demo.
 *
 * PATTERN: Linear chain using start() → addFunction() → addFunction() → ...
 *
 * @returns Built flowchart ready for execution
 */
export function buildPaymentFlow() {
  return new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .addFunction('UpdateInventory', updateInventory)
    .addFunction('SendReceipt', sendReceipt)
    .build();
}

/**
 * Returns the stage functions for testing.
 *
 * WHY: Tests may need direct access to stage functions for unit testing.
 */
export const stages = {
  validateCart,
  processPayment,
  updateInventory,
  sendReceipt,
};

/**
 * Returns the sample cart items for testing.
 */
export { cartItems };

// ============================================================================
// Demo Execution
// ============================================================================

/**
 * Main demo execution.
 *
 * WHY: Demonstrates the complete flow from building to execution.
 * Run with: npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-linear-payment/index.ts
 */
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Demo 1: Linear Flow (Payment Domain)                          ║');
  console.log('║  Pattern: A → B → C → D (sequential execution)                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Building payment flow...\n');

  // Build the pipeline using FlowChartBuilder
  const builder = new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .addFunction('UpdateInventory', updateInventory)
    .addFunction('SendReceipt', sendReceipt);

  console.log('Executing payment flow:\n');

  // Execute the pipeline
  // WHY: execute() runs all stages in sequence, passing scope to each
  const result = await builder.execute(scopeFactory);

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('✓ Payment flow complete!');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('\nFinal stage output:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n📚 Key Takeaways:');
  console.log('   • start() defines the entry point');
  console.log('   • addFunction() chains subsequent stages');
  console.log('   • scope.setObject() stores data for later stages');
  console.log('   • scope.getValue() retrieves data from earlier stages');
  console.log('   • Stages execute in the order they are added\n');
}

// Run the demo
main().catch(console.error);
