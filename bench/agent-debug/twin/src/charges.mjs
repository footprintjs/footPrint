/**
 * What is added to the net amount: tax, shipping, and the grand total
 * (SPEC.md, sections 6.6 to 6.8).
 */
import { lookUp } from './lookup.mjs';
import { roundToCent } from './rounding.mjs';

/** A net amount of this much or more ships free. */
export const FREE_SHIPPING_FROM = 100;
/** The shipping fee's fixed part. */
export const SHIPPING_BASE_FEE = 4.95;
/** The shipping fee per kilogram of total weight. */
export const SHIPPING_PER_KG = 0.85;
/** Express doubles the whole fee. */
export const EXPRESS_FACTOR = 2;

/**
 * Picks the tax rate for the delivery region.
 *
 * The billing region is never used: tax is owed where the goods go. A region
 * the table does not list, or a missing one, uses the default rate; a listed
 * region whose rate is 0 (`export`) uses 0, so the test is "listed", never
 * "has a truthy rate".
 *
 * @param {unknown} shipRegion the order's `shipRegion`, as given
 * @param {Record<string, number>} taxRates
 * @param {number} defaultRate
 * @returns {number}
 */
export function taxRateFor(shipRegion, taxRates, defaultRate) {
  const rate = lookUp(taxRates, shipRegion);
  return rate === undefined ? defaultRate : rate;
}

/**
 * Works out the tax on the net amount (after discounts, not the subtotal).
 * @param {number} net
 * @param {number} rate
 * @returns {number}
 */
export function taxOn(net, rate) {
  return roundToCent(net * rate);
}

/**
 * Works out the shipping charge. The first rule that holds settles it:
 *
 * 1. `shipMethod` exactly `pickup`: 0.
 * 2. Net amount 100 or more: 0, express included. Exactly 100.00 ships free.
 *    This looks at the NET amount, never the subtotal or the grand total.
 * 3. Otherwise fee = 4.95 + (0.85 × weight). Express (exactly `express`) pays
 *    rounded(fee × 2): the whole fee is doubled, base included, and rounded
 *    once after doubling. Anything else (`standard`, missing, `Express`, any
 *    other text) pays rounded(fee).
 *
 * @param {number} net the net amount
 * @param {number} totalWeightKg the order's weight, rounded to the gram
 * @param {unknown} shipMethod the order's `shipMethod`, as given
 * @returns {number}
 */
export function shippingCharge(net, totalWeightKg, shipMethod) {
  if (shipMethod === 'pickup') return 0;
  if (net >= FREE_SHIPPING_FROM) return 0;
  const fee = SHIPPING_BASE_FEE + SHIPPING_PER_KG * totalWeightKg;
  return shipMethod === 'express' ? roundToCent(fee * EXPRESS_FACTOR) : roundToCent(fee);
}

/**
 * Works out what the customer pays: rounded(net + tax + shipping).
 * @param {number} net
 * @param {number} tax
 * @param {number} shipping
 * @returns {number}
 */
export function grandTotalOf(net, tax, shipping) {
  return roundToCent(net + tax + shipping);
}
