/**
 * standard-shipping: the shipping charge for an order that does not ship free.
 *
 * The rule: a base fee plus a charge per kilogram; express costs twice that.
 * Rounded to the cent.
 * Example: 2 kg, standard → 4.95 + 0.85 × 2 = `shipping = 6.65`.
 */
import { roundCents } from '../../money.mjs';

export const purpose = 'Charge the base fee plus a rate per kilogram (double for express).';

/** The fee every shipped order pays. */
const BASE_FEE = 4.95;
/** The charge for each kilogram the order weighs. */
const PER_KG = 0.85;
/** How much more express costs than standard. */
const EXPRESS_FACTOR = 2;

/** @param {any} scope */
export function run(scope) {
  const fee = BASE_FEE + PER_KG * scope.totalWeight;
  scope.shipping = roundCents(scope.shipMethod === 'express' ? fee * EXPRESS_FACTOR : fee);
}
