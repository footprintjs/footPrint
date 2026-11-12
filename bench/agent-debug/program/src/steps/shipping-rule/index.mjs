/**
 * shipping-rule: decides whether the order ships free.
 *
 * Free when the customer collects it at the store, or when the goods cost
 * 100 or more after discounts. Otherwise the standard rate applies.
 * Example: `netAmount = 140` → branch `free-shipping`.
 */
import { decide } from 'footprintjs';

export const purpose = 'Decide whether the order ships free or at the standard rate.';

/** @param {any} scope */
export function run(scope) {
  return decide(
    scope,
    [
      { when: { shipMethod: { eq: 'pickup' } }, then: 'free-shipping', label: 'Collected at the store' },
      { when: { netAmount: { gte: 100 } }, then: 'free-shipping', label: 'Reaches the free-shipping amount' },
    ],
    { branch: 'standard-shipping', label: 'Below the free-shipping amount' },
  );
}
