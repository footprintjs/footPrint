/**
 * The coupon and loyalty discounts and the net amount
 * (SPEC.md, sections 6.3 to 6.5).
 *
 * Both discounts are worked out on the SUBTOTAL, never on what is left after
 * the other one, so a customer can get both in full.
 */
import { lookUp } from './lookup.mjs';
import { roundToCent } from './rounding.mjs';

/** A customer with this many member years or more gets the loyalty discount. */
export const LOYALTY_MIN_YEARS = 5;
/** The share of the subtotal the loyalty discount takes: 2%. */
export const LOYALTY_SHARE = 0.02;

/**
 * Works out the coupon discount on the subtotal.
 *
 * No code, `null`, an empty string or a code the table does not list all give
 * 0; none is an error. Codes match exactly, case included (`spring10` is not
 * `SPRING10`). A percentage coupon is rounded to the cent; a fixed coupon is
 * the smaller of its amount and the subtotal, not rounded further, so it never
 * takes off more than the subtotal.
 *
 * @param {number} subtotal
 * @param {unknown} couponCode the order's `couponCode`, as given
 * @param {Record<string, { percent?: number, fixed?: number }>} coupons the coupon table
 * @returns {number}
 */
export function couponDiscount(subtotal, couponCode, coupons) {
  const coupon = lookUp(coupons, couponCode);
  if (coupon === undefined) return 0;
  // The table gives a coupon one kind, never both; percent is tried first.
  if (coupon.percent !== undefined) return roundToCent((subtotal * coupon.percent) / 100);
  if (coupon.fixed !== undefined) return Math.min(coupon.fixed, subtotal);
  return 0;
}

/**
 * Works out the loyalty discount: 2% of the subtotal, rounded, for a customer
 * with 5 or more member years (exactly 5 is inside); otherwise 0.
 *
 * @param {number} subtotal
 * @param {number} memberYears the customer's whole years with us
 * @returns {number}
 */
export function loyaltyDiscount(subtotal, memberYears) {
  return memberYears >= LOYALTY_MIN_YEARS ? roundToCent(subtotal * LOYALTY_SHARE) : 0;
}

/**
 * Works out the amount after both discounts, rounded. Tax and free shipping
 * are judged on this amount.
 *
 * It can be negative and is not clamped: a fixed coupon is capped at the
 * subtotal, but the loyalty discount is still taken on top (BULK50 on 6.00
 * for a loyal customer: 6 − 6 − 0.12 = −0.12).
 *
 * @param {number} subtotal
 * @param {number} coupon the coupon discount
 * @param {number} loyalty the loyalty discount
 * @returns {number}
 */
export function netAmount(subtotal, coupon, loyalty) {
  return roundToCent(subtotal - coupon - loyalty);
}
