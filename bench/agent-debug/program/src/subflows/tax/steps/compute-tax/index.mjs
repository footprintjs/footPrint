/**
 * compute-tax (inside the tax sub-flowchart): the tax on the amount, rounded
 * to the cent.
 *
 * Example: amount 450 at 0.08 → `tax = 36`.
 */
import { roundCents } from '../../../../money.mjs';

export const purpose = 'Work out the tax on the amount.';

/** @param {any} scope */
export function run(scope) {
  scope.tax = roundCents(scope.amount * scope.rate);
}
