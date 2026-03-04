/**
 * Demo 3: Decider (Order Processing Domain)
 *
 * WHY: This pattern enables conditional branching where exactly ONE branch
 * is selected based on runtime conditions. Unlike parallel children (Demo 2)
 * where all children execute, a decider routes to a single path.
 *
 * PATTERN: Single-Choice Branching - A → ? → (B1 OR B2 OR B3)
 * The decider function reads from scope (shared state) and returns
 * the ID of exactly one branch to execute.
 *
 * BUILDS ON: Demo 1 (Linear Flow), Demo 2 (Parallel Children)
 * - Uses same scope operations
 * - Introduces conditional routing with addDeciderFunction()
 *
 * KEY CONCEPTS:
 * - addDeciderFunction(name, fn, id?): Defines a scope-based decision point
 * - Decider function receives scope, reads shared state, returns branch ID
 * - Exactly ONE branch executes (unlike selector which can pick multiple)
 * - .addFunctionBranch(id, name, fn): Defines a branch option
 * - .setDefault(id): Specifies fallback branch if decider returns unknown ID
 * - .end(): Closes the decider block
 *
 *
 * DECIDER vs SELECTOR:
 * - Decider: Returns single string (branch ID) → ONE branch executes
 * - Selector: Returns array of strings (branch IDs) → MULTIPLE branches execute in parallel
 *
 * DOMAIN: Order Processing
 * Different order types require different fulfillment paths:
 * 1. AnalyzeOrder - Determine order type, write fulfillmentType to scope
 * 2. FulfillmentDecider (reads fulfillmentType from scope) → [StandardFulfillment | ExpressFulfillment | DigitalDelivery]
 * 3. ConfirmOrder - Finalize the order
 */

import { FlowChartBuilder, BaseState } from 'footprint';

// ============================================================================
// Scope Factory
// ============================================================================

/**
 * Creates a scope instance for each stage.
 */
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// Domain Data
// ============================================================================

/**
 * Order types that determine fulfillment path.
 */
export type FulfillmentType = 'standard' | 'express' | 'digital';

/**
 * Sample order data for the demo.
 */
export interface OrderData {
  orderId: string;
  customerId: string;
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    isDigital: boolean;
  }>;
  shippingPriority: 'standard' | 'express';
  totalAmount: number;
}

/**
 * Sample orders demonstrating different fulfillment paths.
 */
export const sampleOrders: Record<string, OrderData> = {
  // Standard physical order
  standard: {
    orderId: 'ORD-STD-001',
    customerId: 'CUST-123',
    items: [
      { sku: 'BOOK-001', name: 'TypeScript Handbook', quantity: 1, isDigital: false },
      { sku: 'GADGET-002', name: 'USB Hub', quantity: 2, isDigital: false },
    ],
    shippingPriority: 'standard',
    totalAmount: 89.97,
  },
  // Express shipping order
  express: {
    orderId: 'ORD-EXP-002',
    customerId: 'CUST-456',
    items: [
      { sku: 'LAPTOP-001', name: 'Developer Laptop', quantity: 1, isDigital: false },
    ],
    shippingPriority: 'express',
    totalAmount: 1299.99,
  },
  // Digital-only order
  digital: {
    orderId: 'ORD-DIG-003',
    customerId: 'CUST-789',
    items: [
      { sku: 'EBOOK-001', name: 'TypeScript eBook', quantity: 1, isDigital: true },
      { sku: 'COURSE-001', name: 'React Course', quantity: 1, isDigital: true },
    ],
    shippingPriority: 'standard', // Ignored for digital
    totalAmount: 49.98,
  },
};

// Current order being processed (set before each run)
let currentOrder: OrderData = sampleOrders.standard;

/**
 * Sets the current order for testing.
 */
export function setCurrentOrder(order: OrderData) {
  currentOrder = order;
}

// ============================================================================
// Stage Functions
// ============================================================================

/**
 * Stage 1: Analyze the order to determine fulfillment type.
 *
 * WHY: This stage examines the order and determines which fulfillment
 * path should be taken. It writes the fulfillmentType to scope so that
 * the scope-based decider (FulfillmentDecider) can read it to route execution.
 *
 * SCOPE OPERATIONS:
 * - setObject('order', order): Stores order for later stages
 * - setObject('fulfillmentType', type): Stores decision for decider
 */
const analyzeOrder = async (scope: BaseState) => {
  console.log('  [1] AnalyzeOrder: Analyzing order...');

  const order = currentOrder;

  // Determine fulfillment type based on order characteristics
  let fulfillmentType: FulfillmentType;

  // Check if all items are digital
  const allDigital = order.items.every((item) => item.isDigital);

  if (allDigital) {
    fulfillmentType = 'digital';
  } else if (order.shippingPriority === 'express') {
    fulfillmentType = 'express';
  } else {
    fulfillmentType = 'standard';
  }

  // Store in scope
  scope.setObject('order', order);
  scope.setObject('fulfillmentType', fulfillmentType);

  console.log(`      Order ${order.orderId}: ${fulfillmentType} fulfillment`);

  // Return value is passed to decider function
  return {
    orderId: order.orderId,
    fulfillmentType,
    itemCount: order.items.length,
    totalAmount: order.totalAmount,
  };
};

/**
 * Branch 1: Standard Fulfillment (3-5 business days)
 *
 * WHY: Handles regular physical orders with standard shipping.
 */
const standardFulfillment = async (scope: BaseState) => {
  console.log('  [2] StandardFulfillment: Processing standard shipment...');

  const order = scope.getValue('order') as OrderData;

  // Simulate standard fulfillment process
  const fulfillmentResult = {
    method: 'standard',
    estimatedDays: 5,
    carrier: 'USPS',
    trackingPrefix: 'STD',
    orderId: order.orderId,
  };

  scope.setObject('fulfillmentResult', fulfillmentResult);

  console.log(`      Standard shipment scheduled: ${fulfillmentResult.estimatedDays} days`);

  return fulfillmentResult;
};

/**
 * Branch 2: Express Fulfillment (1-2 business days)
 *
 * WHY: Handles orders requiring expedited shipping.
 */
const expressFulfillment = async (scope: BaseState) => {
  console.log('  [2] ExpressFulfillment: Processing express shipment...');

  const order = scope.getValue('order') as OrderData;

  // Simulate express fulfillment process
  const fulfillmentResult = {
    method: 'express',
    estimatedDays: 2,
    carrier: 'FedEx',
    trackingPrefix: 'EXP',
    orderId: order.orderId,
    priorityFee: 15.99,
  };

  scope.setObject('fulfillmentResult', fulfillmentResult);

  console.log(`      Express shipment scheduled: ${fulfillmentResult.estimatedDays} days`);

  return fulfillmentResult;
};

/**
 * Branch 3: Digital Delivery (instant)
 *
 * WHY: Handles orders containing only digital products.
 */
const digitalDelivery = async (scope: BaseState) => {
  console.log('  [2] DigitalDelivery: Processing digital delivery...');

  const order = scope.getValue('order') as OrderData;

  // Simulate digital delivery process
  const fulfillmentResult = {
    method: 'digital',
    estimatedDays: 0,
    deliveryMethod: 'email',
    downloadLinks: order.items.map((item) => ({
      sku: item.sku,
      url: `https://downloads.example.com/${item.sku}`,
    })),
    orderId: order.orderId,
  };

  scope.setObject('fulfillmentResult', fulfillmentResult);

  console.log(`      Digital delivery ready: ${order.items.length} items`);

  return fulfillmentResult;
};

/**
 * Stage 3: Confirm the order.
 *
 * WHY: Final stage that confirms the order regardless of fulfillment path.
 * This demonstrates that execution continues after the decider branches merge.
 */
const confirmOrder = async (scope: BaseState) => {
  console.log('  [3] ConfirmOrder: Finalizing order...');

  const order = scope.getValue('order') as OrderData;
  const fulfillmentResult = scope.getValue('fulfillmentResult') as any;

  const confirmation = {
    orderId: order.orderId,
    status: 'confirmed',
    fulfillmentMethod: fulfillmentResult?.method ?? 'unknown',
    estimatedDelivery: fulfillmentResult?.estimatedDays ?? -1,
    confirmedAt: new Date().toISOString(),
  };

  console.log(`      Order confirmed: ${confirmation.orderId}`);

  return confirmation;
};

// ============================================================================
// Decider Function (Scope-Based)
// ============================================================================

/**
 * Scope-based decider function that routes to the appropriate fulfillment branch.
 *
 * WHY: This function reads fulfillmentType from scope (shared state) and returns
 * the ID of the branch to execute. The scope-based approach decouples
 * the decider from the preceding stage's return type.
 *
 * DESIGN: As a scope-based decider (via addDeciderFunction), this function:
 * - Receives scope as its first argument (like any other stage function)
 * - Reads decision data from scope (written by AnalyzeOrder)
 * - Returns a branch ID string
 * - Gets its own step number and debug snapshot
 *
 * @param scope - The scope instance providing access to shared state
 * @returns The branch ID to execute ('standard', 'express', or 'digital')
 */
const fulfillmentDecider = (scope: BaseState): string => {
  // Read fulfillmentType from scope — written by AnalyzeOrder stage
  const type = (scope.getValue('fulfillmentType') as FulfillmentType) ?? 'standard';
  console.log(`  [Decider] Routing to: ${type}`);
  return type;
};

// ============================================================================
// Flow Builder
// ============================================================================

/**
 * Builds the order processing flow with scope-based decider.
 *
 * WHY: Exported for testing. Demonstrates addDeciderFunction() pattern
 * for conditional branching. The decider reads fulfillmentType from scope
 * instead of from the previous stage's output.
 *
 * PATTERN: Single-Choice Branching
 * - AnalyzeOrder determines fulfillment type and writes it to scope
 * - FulfillmentDecider reads fulfillmentType from scope, returns branch ID
 * - Exactly one branch executes
 * - ConfirmOrder runs after the selected branch completes
 *
 * @returns Built flowchart ready for execution
 */
export function buildOrderProcessingFlow() {
  return new FlowChartBuilder()
    .start('AnalyzeOrder', analyzeOrder)
    // addDeciderFunction creates a first-class stage that reads from scope
    // NOTE: For scope-based deciders, default fallback uses a branch with id='default'
    .addDeciderFunction('FulfillmentDecider', fulfillmentDecider as any, 'fulfillment-decider')
      .addFunctionBranch('standard', 'StandardFulfillment', standardFulfillment)
      .addFunctionBranch('express', 'ExpressFulfillment', expressFulfillment)
      .addFunctionBranch('digital', 'DigitalDelivery', digitalDelivery)
      .addFunctionBranch('default', 'StandardFulfillment', standardFulfillment) // Fallback for unknown IDs
      .end()
    .addFunction('ConfirmOrder', confirmOrder)
    .build();
}

/**
 * Returns the stage functions for testing.
 */
export const stages = {
  analyzeOrder,
  standardFulfillment,
  expressFulfillment,
  digitalDelivery,
  confirmOrder,
};

/**
 * Returns the decider function for testing.
 */
export { fulfillmentDecider };

// ============================================================================
// Demo Execution
// ============================================================================

/**
 * Main demo execution.
 *
 * WHY: Demonstrates decider routing with different order types.
 * Run with: npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-decider-order/index.ts
 */
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Demo 3: Decider (Order Processing Domain)                     ║');
  console.log('║  Pattern: A → ? → (B1 OR B2 OR B3) (single-choice)             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Test with different order types
  const testCases: Array<{ name: string; order: OrderData }> = [
    { name: 'Standard Order', order: sampleOrders.standard },
    { name: 'Express Order', order: sampleOrders.express },
    { name: 'Digital Order', order: sampleOrders.digital },
  ];

  for (const testCase of testCases) {
    console.log(`\n─── ${testCase.name} ───\n`);

    setCurrentOrder(testCase.order);

    const builder = new FlowChartBuilder()
      .start('AnalyzeOrder', analyzeOrder)
      // addDeciderFunction: scope-based decider
      .addDeciderFunction('FulfillmentDecider', fulfillmentDecider as any, 'fulfillment-decider')
        .addFunctionBranch('standard', 'StandardFulfillment', standardFulfillment)
        .addFunctionBranch('express', 'ExpressFulfillment', expressFulfillment)
        .addFunctionBranch('digital', 'DigitalDelivery', digitalDelivery)
        .addFunctionBranch('default', 'StandardFulfillment', standardFulfillment)
        .end()
      .addFunction('ConfirmOrder', confirmOrder);

    const result = await builder.execute(scopeFactory);

    console.log('\n  Result:');
    console.log(JSON.stringify(result, null, 2));
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('✓ Decider demo complete!');
  console.log('════════════════════════════════════════════════════════════════');

  console.log('\n📚 Key Takeaways:');
  console.log('   • addDeciderFunction(name, fn) creates a scope-based decision point');
  console.log('   • Decider function reads from scope (shared state), returns a branch ID');
  console.log('   • Exactly ONE branch executes (not multiple like selector)');
  console.log('   • .setDefault(id) provides fallback for unknown IDs');
  console.log('   • Execution continues after the selected branch completes');
  console.log('   • Use addDeciderFunction(name, fn) for conditional branching\n');
}

// Run the demo
main().catch(console.error);
