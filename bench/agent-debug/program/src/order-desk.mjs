/**
 * The order desk as a function: hand it an order, get the outcome.
 *
 * Why a separate file from the chart: the chart says how the steps connect;
 * this file runs it and picks the keys a caller sees.
 * Example: `await runOrder(order)` → `{ status: 'approved', grandTotal: 475.2, ... }`.
 */
import { FlowChartExecutor } from 'footprintjs';

import { buildChart } from './chart.mjs';

/** The keys of the final state that make up the desk's answer, in the order shown. */
export const RESULT_KEYS = [
  'orderId',
  'status',
  'reasons',
  'subtotal',
  'discount',
  'loyaltyDiscount',
  'tax',
  'shipping',
  'grandTotal',
];

/**
 * Runs one order through the desk.
 * @param {object} order the order, as in a fixture's `order` field
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runOrder(order) {
  const executor = new FlowChartExecutor(buildChart());
  await executor.run({ input: { order } });
  const state = executor.getSnapshot().sharedState;
  return Object.fromEntries(RESULT_KEYS.map((key) => [key, state[key]]));
}
