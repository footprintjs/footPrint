/**
 * loyalty-discount: thanks long-standing customers.
 *
 * The rule: a customer who has bought from us for five years or more gets 2%
 * off the subtotal, rounded to the cent.
 * Example: 7 years, subtotal 500.00 → `loyaltyDiscount = 10`.
 */
import { roundCents } from '../../money.mjs';

export const purpose = 'Give long-standing customers their loyalty discount.';

/** Years of buying from which the loyalty discount applies. */
const LOYAL_YEARS = 5;
/** The loyalty discount, as a share of the subtotal. */
const LOYAL_RATE = 0.02;

/** @param {any} scope */
export function run(scope) {
  const years = scope.customer.memberYears;
  scope.loyaltyDiscount = years >= LOYAL_YEARS ? roundCents(scope.subtotal * LOYAL_RATE) : 0;
}
