/**
 * approval: the order's outcome, as rules in order; the first rule that
 * matches wins.
 *
 * 1. an item out of stock → hold;
 * 2. over the credit or order limit → reject;
 * 3. a grand total over 2000 → a person reviews it;
 * otherwise → approve.
 * Example: everything in stock, within limits, 480.00 → branch `approve`.
 */
import { decide } from 'footprintjs';

export const purpose = 'Decide the outcome: hold, reject, review or approve.';

/** @param {any} scope */
export function run(scope) {
  return decide(
    scope,
    [
      { when: { stockOk: { eq: false } }, then: 'hold', label: 'Some items are out of stock' },
      { when: { creditOk: { eq: false } }, then: 'reject', label: 'Over the credit or order limit' },
      { when: { grandTotal: { gt: 2000 } }, then: 'review', label: 'Large order needs a person' },
    ],
    { branch: 'approve', label: 'Every check passed' },
  );
}
