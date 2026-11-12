/**
 * check-stock: one of the two checks that run side by side. It lists every
 * item the shelf cannot fill.
 *
 * Example: 6 desk lamps ordered, 4 on the shelf → `stockOk = false`,
 * `shortSkus = ['DESK-LAMP']`.
 */
import { STOCK } from '../../data/stock.mjs';

export const purpose = 'Check that the shelf holds every item in the quantity ordered.';

/** @param {any} scope */
export function run(scope) {
  const short = [];
  for (const line of scope.pricedLines) {
    if ((STOCK[line.sku] ?? 0) < line.qty) short.push(line.sku);
  }
  scope.stockOk = short.length === 0;
  scope.shortSkus = short;
}
