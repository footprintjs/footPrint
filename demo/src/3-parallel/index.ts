/**
 * Demo 3: Parallel Execution (Fork Pattern)
 *
 * Shows parallel execution with addListOfFunction() - fork-join pattern.
 */

import { FlowChartBuilder, BaseState } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// Helper
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stage functions
const prepareRequest = async (scope: BaseState) => {
  console.log('  [Prepare] Setting up parallel fetches...');
  scope.setObject('userId', 'user-123');
};

const fetchUserProfile = async () => {
  console.log('  [Profile] Fetching user profile...');
  await sleep(100);
  return { name: 'Alice', email: 'alice@example.com' };
};

const fetchUserOrders = async () => {
  console.log('  [Orders] Fetching user orders...');
  await sleep(150);
  return { orders: [{ id: 1, total: 99.99 }, { id: 2, total: 149.99 }] };
};

const fetchUserPreferences = async () => {
  console.log('  [Prefs] Fetching user preferences...');
  await sleep(80);
  return { theme: 'dark', notifications: true };
};

const aggregateResults = async () => {
  console.log('  [Aggregate] Combining all results...');
};

// Build the parallel flow
export function buildParallelFlow() {
  return new FlowChartBuilder()
    .start('PrepareRequest', prepareRequest)
    .addListOfFunction([
      { id: 'profile', name: 'FetchUserProfile', fn: fetchUserProfile },
      { id: 'orders', name: 'FetchUserOrders', fn: fetchUserOrders },
      { id: 'preferences', name: 'FetchUserPreferences', fn: fetchUserPreferences },
    ])
    .addFunction('AggregateResults', aggregateResults)
    .build();
}

// Execute the demo
async function main() {
  console.log('\n=== Parallel Demo (Fork Pattern) ===\n');

  const builder = new FlowChartBuilder()
    .start('PrepareRequest', prepareRequest)
    .addListOfFunction([
      { id: 'profile', name: 'FetchUserProfile', fn: fetchUserProfile },
      { id: 'orders', name: 'FetchUserOrders', fn: fetchUserOrders },
      { id: 'preferences', name: 'FetchUserPreferences', fn: fetchUserPreferences },
    ])
    .addFunction('AggregateResults', aggregateResults);

  console.log('Starting parallel execution...\n');
  const start = Date.now();

  const result = await builder.execute(scopeFactory);

  const elapsed = Date.now() - start;
  console.log(`\n✓ Parallel demo complete! (${elapsed}ms)`);
  console.log('  Note: ~150ms total despite 330ms of work = true parallelism!');
  console.log('  Final result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
