/**
 * start-lines: sets up the loop that prices the order one line at a time.
 *
 * Why a loop of steps and not a `for` inside one step: each line's price is
 * then its own step in the run, and a wrong line can be found by itself.
 * Example: two lines → `lineIndex = 0`, `lineCount = 2`, `subtotal = 0`.
 */

export const purpose = 'Start the line loop: first line, empty totals.';

/** @param {any} scope */
export function run(scope) {
  scope.lineIndex = 0;
  scope.lineCount = scope.lines.length;
  scope.pricedLines = [];
  scope.subtotal = 0;
  scope.totalWeight = 0;
}
