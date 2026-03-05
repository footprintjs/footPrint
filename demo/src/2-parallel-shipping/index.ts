/**
 * Demo 2: Parallel Children (Shipping Domain)
 *
 * WHY: This pattern enables concurrent execution of independent operations.
 * Instead of waiting for each operation sequentially (total time = sum of all),
 * parallel execution completes in the time of the slowest operation (total = max).
 *
 * PATTERN: Fork-Join - A → [B1, B2, B3] → C
 * Multiple children execute in parallel, then flow continues after all complete.
 *
 * BUILDS ON: Demo 1 (Linear Flow)
 * - Uses same scope operations (setValue/getValue)
 * - Adds parallel execution with addListOfFunction()
 *
 * KEY CONCEPTS:
 * - addListOfFunction(): Defines parallel children
 * - All children execute concurrently (Promise.all semantics)
 * - Total time ≈ max(child times), not sum(child times)
 * - Children can READ from parent scope
 * - Children have ISOLATED scopes (writes don't propagate to parent)
 * - Parallel children return values go into a result bundle
 *
 * IMPORTANT SCOPE BEHAVIOR:
 * Parallel children have ISOLATED scopes. This means:
 * - Children CAN read values written by parent stages
 * - Children CANNOT write values that subsequent stages can read via scope
 * - Parallel children return values go into the result bundle
 *
 * DOMAIN: Shipping Preparation
 * When preparing a shipment, multiple independent checks can run in parallel:
 * 1. PrepareShipment - Initialize shipment data
 * 2. [CalculateRate, CheckInventory, ValidateAddress] - Run in parallel
 * 3. CreateLabel - Uses data from PrepareShipment (not from children's scope writes)
 */

import { FlowChartBuilder, BaseState } from 'footprint';

// ============================================================================
// Scope Factory
// ============================================================================

/**
 * Creates a scope instance for each stage.
 *
 * WHY: Same pattern as Demo 1 - provides scope access to each stage.
 */
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Simulates async work with a delay.
 *
 * WHY: Demonstrates that parallel execution actually runs concurrently.
 * If sequential, total time would be sum of all delays.
 * If parallel, total time is approximately max of all delays.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Domain Data
// ============================================================================

/**
 * Sample shipment data for the demo.
 */
interface ShipmentData {
  orderId: string;
  items: Array<{ sku: string; quantity: number; weight: number }>;
  destination: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}

const shipmentData: ShipmentData = {
  orderId: 'ORD-2024-001',
  items: [
    { sku: 'WIDGET-001', quantity: 2, weight: 0.5 },
    { sku: 'GADGET-002', quantity: 1, weight: 1.2 },
  ],
  destination: {
    street: '123 Main St',
    city: 'Seattle',
    state: 'WA',
    zip: '98101',
    country: 'USA',
  },
};

// ============================================================================
// Stage Functions
// ============================================================================

/**
 * Stage 1: Prepare the shipment.
 *
 * WHY: Entry point that initializes shipment data in scope.
 * This data is then available to all parallel children (they can READ it).
 *
 * SCOPE OPERATIONS:
 * - setObject('shipment', data): Stores shipment for children to READ
 * - setObject('totalWeight', weight): Stores weight for children to READ
 */
const prepareShipment = async (scope: BaseState) => {
  console.log('  [1] PrepareShipment: Initializing shipment data...');

  // Calculate total weight
  const totalWeight = shipmentData.items.reduce((sum, item) => sum + item.weight * item.quantity, 0);

  // Store shipment data - children can READ these values
  scope.setValue('shipment', shipmentData);
  scope.setValue('totalWeight', totalWeight);

  console.log(`      Shipment prepared: ${shipmentData.orderId}, ${totalWeight}kg total`);
};

/**
 * Parallel Child 1: Calculate shipping rate.
 *
 * WHY: Rate calculation is independent of inventory check and address validation.
 * Running in parallel reduces total processing time.
 *
 * SCOPE BEHAVIOR:
 * - CAN read 'totalWeight' and 'shipment' from parent scope
 * - Writes to scope are ISOLATED (not visible to CreateLabel)
 * - Return value goes into the parallel result bundle
 *
 * TIMING: 150ms simulated delay
 */
const calculateRate = async (scope: BaseState) => {
  const startTime = Date.now();
  console.log('  [2a] CalculateRate: Calculating shipping rate...');

  // Simulate API call to rate service
  await sleep(150);

  // CAN read from parent scope
  const totalWeight = scope.getValue('totalWeight') as number;
  const shipment = scope.getValue('shipment') as ShipmentData;

  // Simple rate calculation based on weight and destination
  const baseRate = 5.99;
  const weightRate = totalWeight * 2.5;
  const distanceRate = shipment.destination.country === 'USA' ? 0 : 15;
  const totalRate = baseRate + weightRate + distanceRate;

  const elapsed = Date.now() - startTime;
  console.log(`      Rate calculated: $${totalRate.toFixed(2)} (${elapsed}ms)`);

  // Parallel children return into the result bundle
  return {
    rate: totalRate,
    breakdown: { baseRate, weightRate, distanceRate },
    calculationTime: elapsed,
  };
};

/**
 * Parallel Child 2: Check inventory availability.
 *
 * WHY: Inventory check is independent of rate calculation and address validation.
 * Can run concurrently to save time.
 *
 * TIMING: 100ms simulated delay
 */
const checkInventory = async (scope: BaseState) => {
  const startTime = Date.now();
  console.log('  [2b] CheckInventory: Verifying inventory levels...');

  // Simulate inventory system query
  await sleep(100);

  // CAN read from parent scope
  const shipment = scope.getValue('shipment') as ShipmentData;

  // Simulate inventory check (all items available)
  const inventoryStatus = shipment.items.map((item) => ({
    sku: item.sku,
    requested: item.quantity,
    available: item.quantity + Math.floor(Math.random() * 10), // Always have enough
    reserved: true,
  }));

  const elapsed = Date.now() - startTime;
  console.log(`      Inventory verified: ${inventoryStatus.length} items reserved (${elapsed}ms)`);

  return {
    allAvailable: true,
    items: inventoryStatus,
    checkTime: elapsed,
  };
};

/**
 * Parallel Child 3: Validate shipping address.
 *
 * WHY: Address validation is independent of rate and inventory.
 * External address validation API can be called concurrently.
 *
 * TIMING: 80ms simulated delay
 */
const validateAddress = async (scope: BaseState) => {
  const startTime = Date.now();
  console.log('  [2c] ValidateAddress: Validating shipping address...');

  // Simulate address validation API
  await sleep(80);

  // CAN read from parent scope
  const shipment = scope.getValue('shipment') as ShipmentData;

  // Simulate address validation result
  const validationResult = {
    valid: true,
    normalized: {
      ...shipment.destination,
      street: shipment.destination.street.toUpperCase(),
      city: shipment.destination.city.toUpperCase(),
    },
    deliverable: true,
    residentialIndicator: true,
  };

  const elapsed = Date.now() - startTime;
  console.log(`      Address validated: ${validationResult.normalized.city}, ${validationResult.normalized.state} (${elapsed}ms)`);

  return {
    valid: true,
    normalized: validationResult.normalized,
    validationTime: elapsed,
  };
};

/**
 * Stage 3: Create shipping label.
 *
 * WHY: Final stage that creates the shipping label.
 * This stage runs after ALL parallel children complete.
 *
 * IMPORTANT: This stage reads from the PARENT scope (PrepareShipment's writes),
 * NOT from the children's scope writes (which are isolated).
 *
 * To access children's results, you would need to use a different pattern
 * (e.g., subflows with output mapping, or a custom aggregation stage).
 */
const createLabel = async (scope: BaseState) => {
  console.log('  [3] CreateLabel: Creating shipping label...');

  // Read from PARENT scope (PrepareShipment's writes)
  // Children's scope writes are NOT visible here due to scope isolation
  const shipment = scope.getValue('shipment') as ShipmentData;
  const totalWeight = scope.getValue('totalWeight') as number;

  // Generate tracking number
  const trackingNumber = `TRK-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Create label using parent scope data
  const label = {
    trackingNumber,
    orderId: shipment.orderId,
    totalWeight,
    destination: shipment.destination,
    createdAt: new Date().toISOString(),
  };

  console.log(`      Label created: ${trackingNumber}`);
};

// ============================================================================
// Flow Builder
// ============================================================================

/**
 * Builds the parallel shipping flow.
 *
 * WHY: Exported for testing. Demonstrates addListOfFunction() pattern.
 *
 * PATTERN: Fork-Join
 * - PrepareShipment runs first
 * - Three children run in parallel (can READ parent scope)
 * - CreateLabel runs after all children complete (reads from parent scope)
 *
 * @returns Built flowchart ready for execution
 */
export function buildParallelShippingFlow() {
  return new FlowChartBuilder()
    .start('PrepareShipment', prepareShipment)
    .addListOfFunction([
      { id: 'rate', name: 'CalculateRate', fn: calculateRate },
      { id: 'inventory', name: 'CheckInventory', fn: checkInventory },
      { id: 'address', name: 'ValidateAddress', fn: validateAddress },
    ])
    .addFunction('CreateLabel', createLabel)
    .build();
}

/**
 * Returns the stage functions for testing.
 */
export const stages = {
  prepareShipment,
  calculateRate,
  checkInventory,
  validateAddress,
  createLabel,
};

/**
 * Returns the sample shipment data for testing.
 */
export { shipmentData };

/**
 * Timing constants for testing parallel execution.
 */
export const TIMING = {
  CALCULATE_RATE_MS: 150,
  CHECK_INVENTORY_MS: 100,
  VALIDATE_ADDRESS_MS: 80,
  // Sum if sequential: 330ms
  // Max if parallel: 150ms (plus overhead)
  SEQUENTIAL_SUM_MS: 330,
  PARALLEL_MAX_MS: 150,
};

// ============================================================================
// Demo Execution
// ============================================================================

/**
 * Main demo execution.
 *
 * WHY: Demonstrates parallel execution timing.
 * Run with: npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-parallel-shipping/index.ts
 */
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Demo 2: Parallel Children (Shipping Domain)                   ║');
  console.log('║  Pattern: A → [B1, B2, B3] → C (fork-join)                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Building parallel shipping flow...\n');

  const builder = new FlowChartBuilder()
    .start('PrepareShipment', prepareShipment)
    .addListOfFunction([
      { id: 'rate', name: 'CalculateRate', fn: calculateRate },
      { id: 'inventory', name: 'CheckInventory', fn: checkInventory },
      { id: 'address', name: 'ValidateAddress', fn: validateAddress },
    ])
    .addFunction('CreateLabel', createLabel);

  console.log('Executing parallel shipping flow:\n');
  console.log('  Expected timing:');
  console.log(`    - If sequential: ~${TIMING.SEQUENTIAL_SUM_MS}ms (sum of all delays)`);
  console.log(`    - If parallel: ~${TIMING.PARALLEL_MAX_MS}ms (max delay + overhead)\n`);

  const startTime = Date.now();
  const result = await builder.execute(scopeFactory);
  const totalTime = Date.now() - startTime;

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`✓ Parallel shipping flow complete! (${totalTime}ms total)`);
  console.log('════════════════════════════════════════════════════════════════');

  if (totalTime < TIMING.SEQUENTIAL_SUM_MS * 0.8) {
    console.log(`\n  ✓ Parallel execution confirmed!`);
    console.log(`    Total time (${totalTime}ms) << Sequential time (${TIMING.SEQUENTIAL_SUM_MS}ms)`);
  } else {
    console.log(`\n  ⚠ Execution may not be parallel`);
    console.log(`    Total time (${totalTime}ms) ≈ Sequential time (${TIMING.SEQUENTIAL_SUM_MS}ms)`);
  }

  console.log('\nFinal stage output:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n📚 Key Takeaways:');
  console.log('   • addListOfFunction() executes children in parallel');
  console.log('   • Total time ≈ max(child times), not sum');
  console.log('   • Children CAN read from parent scope');
  console.log('   • Children have ISOLATED scopes (writes not visible to siblings/parent)');
  console.log('   • Parallel children return values go into the result bundle');
  console.log('   • Next stage waits for ALL children to complete\n');
}

// Run the demo
main().catch(console.error);
