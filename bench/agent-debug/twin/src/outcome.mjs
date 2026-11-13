/**
 * The order's outcome (SPEC.md, section 6.11).
 */

/** A grand total above this (not equal to it) goes to a person for review. */
export const LARGE_ORDER_ABOVE = 2000;

/**
 * Decides the status and its reasons. The first rule that holds wins:
 *
 * 1. a short line → `on-hold`, one `out of stock: <sku>` per short line;
 * 2. the credit check failed → `rejected` (the reason does not say which limit);
 * 3. grand total more than 2000 → `review` (exactly 2000.00 is not);
 * 4. otherwise `approved`, no reasons.
 *
 * Stock is tried before credit, and credit before size: a short order is held
 * even when it is also over a limit, and a large order over a limit is
 * rejected, not reviewed.
 *
 * @param {{ shortItems: string[], creditOk: boolean, grandTotal: number }} facts
 * @returns {{ status: 'on-hold' | 'rejected' | 'review' | 'approved', reasons: string[] }}
 */
export function decideOutcome({ shortItems, creditOk, grandTotal }) {
  if (shortItems.length > 0) {
    return { status: 'on-hold', reasons: shortItems.map((sku) => `out of stock: ${sku}`) };
  }
  if (!creditOk) return { status: 'rejected', reasons: ['over the credit or order limit'] };
  if (grandTotal > LARGE_ORDER_ABOVE) return { status: 'review', reasons: ['large order'] };
  return { status: 'approved', reasons: [] };
}
