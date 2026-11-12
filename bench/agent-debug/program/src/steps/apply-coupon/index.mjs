/**
 * apply-coupon: takes a coupon off the subtotal.
 *
 * A percentage coupon is rounded to the cent; a fixed coupon never takes off
 * more than the subtotal. An unknown or missing code gives no discount.
 * Example: `SPRING10` on 200.00 → `discount = 20`.
 */
import { COUPONS } from '../../data/coupons.mjs';
import { roundCents } from '../../money.mjs';

export const purpose = 'Work out the coupon discount on the subtotal.';

/** @param {any} scope */
export function run(scope) {
  const coupon = COUPONS[scope.couponCode];
  if (!coupon) {
    scope.discount = 0;
    return;
  }
  scope.discount = coupon.percent
    ? roundCents((scope.subtotal * coupon.percent) / 100)
    : Math.min(coupon.fixed ?? 0, scope.subtotal);
}
