/**
 * Coupon codes. A coupon takes either a percentage or a fixed amount off the
 * subtotal, never both.
 *
 * Example: `COUPONS.SPRING10` → `{ percent: 10 }`.
 *
 * @type {Record<string, { percent?: number, fixed?: number }>}
 */
export const COUPONS = {
  SPRING10: { percent: 10 },
  WELCOME5: { fixed: 5 },
  BULK50: { fixed: 50 },
};
