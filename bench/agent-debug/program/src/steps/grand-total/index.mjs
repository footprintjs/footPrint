/**
 * grand-total: what the customer pays: the goods after discounts, plus tax,
 * plus shipping.
 *
 * Example: net 440, tax 35.20, shipping 0 → `grandTotal = 475.2`.
 */
import { roundCents } from '../../money.mjs';

export const purpose = 'Add tax and shipping to the discounted amount.';

/** @param {any} scope */
export function run(scope) {
  scope.grandTotal = roundCents(scope.netAmount + scope.tax + scope.shipping);
}
