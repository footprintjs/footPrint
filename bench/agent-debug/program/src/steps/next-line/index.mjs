/**
 * next-line: moves the loop on to the next line of the order. The chart then
 * goes back to `price-line`.
 *
 * Example: `lineIndex = 0` → `lineIndex = 1`.
 */

export const purpose = 'Move on to the next line, then price it.';

/** @param {any} scope */
export function run(scope) {
  scope.lineIndex = scope.lineIndex + 1;
}
