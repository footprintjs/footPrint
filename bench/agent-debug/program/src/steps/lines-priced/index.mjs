/**
 * lines-priced: the loop's exit. It notes how many lines were priced, so the
 * count can be compared with the order.
 *
 * Example: three lines priced → `linesPriced = 3`.
 */

export const purpose = 'Leave the line loop and note how many lines were priced.';

/** @param {any} scope */
export function run(scope) {
  scope.linesPriced = scope.pricedLines.length;
}
