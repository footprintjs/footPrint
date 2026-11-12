/**
 * net-amount: what the goods cost after every discount. Tax and shipping
 * are worked out from this amount.
 *
 * Example: subtotal 500, coupon 40, loyalty 10 → `netAmount = 450`.
 */
import { roundCents } from '../../money.mjs';

export const purpose = 'Take the discounts off the subtotal.';

/** @param {any} scope */
export function run(scope) {
  scope.netAmount = roundCents(scope.subtotal - scope.discount - scope.loyaltyDiscount);
}
