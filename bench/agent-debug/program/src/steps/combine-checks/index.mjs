/**
 * combine-checks: brings the answers of the two side-by-side checks together.
 *
 * Why it exists: each side-by-side check writes in its own space
 * (`runs.<check id>.<key>`), so a later step cannot see it as a plain key.
 * This step copies each answer to a plain key the approval reads.
 * Example: `runs.check-stock.stockOk = true` → `stockOk = true`.
 */

export const purpose = 'Copy the stock and credit answers to the keys the approval reads.';

/** @param {any} scope */
export function run(scope) {
  scope.stockOk = scope.$read('runs.check-stock.stockOk');
  scope.shortSkus = scope.$read('runs.check-stock.shortSkus');
  scope.creditOk = scope.$read('runs.check-credit.creditOk');
}
