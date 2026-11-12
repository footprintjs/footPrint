/**
 * hold: the order waits until the shelf can fill it, naming each short item.
 *
 * Example: `shortSkus = ['DESK-LAMP']` → `status = 'on-hold'`,
 * `reasons = ['out of stock: DESK-LAMP']`.
 */

export const purpose = 'Hold the order and name each item out of stock.';

/** @param {any} scope */
export function run(scope) {
  scope.status = 'on-hold';
  scope.reasons = scope.shortSkus.map((sku) => `out of stock: ${sku}`);
}
