/**
 * Scores one answer to a question, in the harness PARENT: the expected
 * answer is read from `hidden/answers.json` (questions/generate.mjs), which
 * no working folder holds and no child may read, and compared by the
 * question's shape (harness/shapes.mjs · compareAnswer). No partial credit;
 * a malformed answer or no answer at all is wrong, with the reason kept.
 * Example: `scoreQuestion(question, 6)` → `{ solved: true, expected: 6, answerProblem: null }`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BENCH_DIR } from './runtime.mjs';
import { compareAnswer } from './shapes.mjs';

/** @returns {Record<string, unknown>} */
export function expectedAnswers() {
  return JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'answers.json'), 'utf8'));
}

/**
 * @param {{ id: string, shape: any }} question @param {unknown} given the `answer` field the agent sent (undefined: none)
 * @param {Record<string, unknown>} [answers]
 */
export function scoreQuestion(question, given, answers = expectedAnswers()) {
  if (!Object.hasOwn(answers, question.id)) throw new Error(`hidden/answers.json has no answer for ${question.id}`);
  const expected = answers[question.id];
  const { right, problem } = compareAnswer(question.shape, expected, given);
  return { solved: right, expected, answerProblem: problem };
}
