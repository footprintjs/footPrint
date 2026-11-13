/**
 * The thirty understanding questions of part 2 (RULE-2.md, "The tasks"),
 * ten of each kind, in one list.
 *
 * A question: `id`, `kind` (`program` | `run` | `why`), `text` (the task
 * text, word for word, before the one closing sentence of
 * harness/prompt.mjs · questionText), `fixture` (run and why questions),
 * `shape` (harness/shapes.mjs), `rules` (questions/rules.mjs), `intermediate`
 * (the answer is not in the printed result), `howWithPrints` (one line: how
 * an agent with only the code and prints establishes it), `howWithPrintsTwin`
 * (the twin's way, only where it differs) and `derive` (the answer function,
 * run by questions/generate.mjs on F and by test/twin-answers.test.mjs on
 * the twin).
 * Who may import this folder: the harness PARENT (batch, scripts, report)
 * and the generator. Never a tool, never a child: a test walks the tools'
 * imports and the runtime folder to prove it.
 * Example: `loadQuestions().length` → `30`.
 */
import { checkShape } from '../harness/shapes.mjs';
import { PROGRAM_QUESTIONS } from './program.mjs';
import { RUN_QUESTIONS } from './run.mjs';
import { WHY_QUESTIONS } from './why.mjs';

export const KINDS = Object.freeze(['program', 'run', 'why']);

/** @returns {any[]} every question, with its kind and `type: 'question'` */
export function loadQuestions() {
  const all = [
    ...PROGRAM_QUESTIONS.map((q) => ({ ...q, kind: 'program' })),
    ...RUN_QUESTIONS.map((q) => ({ ...q, kind: 'run' })),
    ...WHY_QUESTIONS.map((q) => ({ ...q, kind: 'why' })),
  ];
  for (const q of all) checkShape(q.shape);
  return all.map((q) => Object.freeze({ type: 'question', ...q }));
}
