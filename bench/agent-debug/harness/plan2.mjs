/**
 * The plan and the limits of part 2 (RULE-2.md, "The model and the budget"),
 * in one place. The per-run limits, the prices and the 15-dollar stop are
 * part 1's (budget.mjs), unchanged; "No decision" past 20 unfinished runs
 * is compare2.mjs · MAX_UNFINISHED.
 *
 * - The paid batch: the 30 questions and the 10 faults, in set-ups P, 1, 2
 *   and 3, 5 times each: 800 runs, in one order shuffled with `seed` and
 *   written to order.json before the first run.
 * - The smoke batch: one question of each kind and one fault (part 1's smoke
 *   fault), once in each set-up: 16 runs.
 * Example: `PART2.repeats` → `5`.
 */
export const PART2 = Object.freeze({
  setups: Object.freeze(['P', 1, 2, 3]),
  repeats: 5,
  seed: 20261113,
  smoke: Object.freeze({
    questions: Object.freeze(['program-free-shipping', 'run-tax-rate', 'why-rejected-limits']),
    faults: Object.freeze(['wrong-key-read']),
    setups: Object.freeze(['P', 1, 2, 3]),
    repeats: 1,
  }),
});

/**
 * The rehearsal's script for a question, by the question's place in the
 * list (RULE-2.md asks for an agent that answers right, one that answers
 * wrong and one that never answers): 0 right, 1 wrong, 2 never.
 * @param {number} index
 * @returns {'right' | 'wrong' | 'never'}
 */
export function rehearsalScriptFor(index) {
  return /** @type {const} */ (['right', 'wrong', 'never'])[index % 3];
}

/**
 * The three fault pairs the fairness reader judged easier to SEE in the
 * twin than in the flowchart program (twin-proof/FAIRNESS-READING-1.md,
 * finding 4; RULE-2.md, "Changed after the fairness reading"). Their twin
 * edits give the flowchart program's faulty bytes on every order tried,
 * so they stay; but each looks odd where it stands, while in the flowchart
 * program the fault is one token in one of 35 files. The report gives every
 * comparison on the data-flow faults with them and, in a row that decides
 * nothing, without them. The ONE list of them.
 */
export const EASIER_IN_TWIN = Object.freeze({
  faults: Object.freeze(['loop-stops-early', 'missing-write', 'wrong-default-branch']),
  why: Object.freeze({
    'loop-stops-early': 'the twin\'s plant is `lines.slice(0, lines.length - 1 || 1)`, an odd expression right in the loop',
    'missing-write': 'the twin\'s plant is the literal `creditOk: true` beside a credit result computed one line above',
    'wrong-default-branch': 'the twin\'s plant is a fee worked out and never used, followed by `return 0;`',
  }),
});
