/**
 * Shortens a long text by keeping its start and its end, and saying how
 * much of the middle was cut.
 *
 * Why the end too: a program's last lines (its result, the last log before a
 * crash) are what a developer reads first; cutting only the end would hide
 * them behind the logs (RULE.md 1.3, change 7).
 * Example: `headAndTail('abcdefghij', 2, 3)` → `ab\n[… 5 characters cut from the middle …]\nhij`.
 */

/** @param {string} text @param {number} head @param {number} tail @param {number} [alreadyCut] characters the child had already dropped between them */
export function headAndTail(text, head, tail, alreadyCut = 0) {
  if (text.length <= head + tail && alreadyCut === 0) return text;
  const start = text.slice(0, Math.min(head, text.length));
  const end = text.length > head ? text.slice(Math.max(head, text.length - tail)) : '';
  const cut = text.length - start.length - end.length + alreadyCut;
  return `${start}\n[… ${cut} characters cut from the middle …]\n${end}`;
}
