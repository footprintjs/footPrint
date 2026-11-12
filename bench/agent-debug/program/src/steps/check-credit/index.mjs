/**
 * check-credit: the other check that runs beside the stock check.
 *
 * The rule: what the customer owes plus this order must stay within their
 * credit limit, and this order alone must stay within their order limit.
 * Example: owes 1200, limit 5000, order 2500 → 3700 ≤ 5000 and 2500 ≤ 3000 → `creditOk = true`.
 */
import { roundCents } from '../../money.mjs';

export const purpose = 'Check the order against the credit limit and the order limit.';

/** @param {any} scope */
export function run(scope) {
  const c = scope.customer;
  const total = scope.grandTotal;
  const withinCredit = c.openBalance + total <= c.creditLimit;
  const withinOrderLimit = total <= c.orderLimit;
  scope.creditOk = withinCredit && withinOrderLimit;
  scope.headroom = roundCents(c.creditLimit - c.openBalance - total);
}
