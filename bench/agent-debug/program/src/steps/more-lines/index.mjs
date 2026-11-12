/**
 * more-lines: the loop's decision. While lines are left, go on to the next
 * line; when none are left, leave the loop.
 *
 * The rule is data (`decide()`), so the run records which rule matched.
 * Example: `linesLeft = 1` → branch `next-line`; `linesLeft = 0` → `lines-priced`.
 */
import { decide } from 'footprintjs';

export const purpose = 'Decide whether another line is left to price.';

/** @param {any} scope */
export function run(scope) {
  return decide(
    scope,
    [{ when: { linesLeft: { gt: 0 } }, then: 'next-line', label: 'Lines left to price' }],
    { branch: 'lines-priced', label: 'Every line priced' },
  );
}
