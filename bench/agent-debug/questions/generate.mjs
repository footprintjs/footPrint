/**
 * Computes every question's expected answer from F's real runs and writes
 * them to `hidden/answers.json` (RULE-2.md: "computed by a script ... never
 * typed by hand"). `test/questions.test.mjs` runs `computeAnswers` again and
 * compares it with the committed file, so the two can never drift.
 *
 * Why hidden/: no working folder holds it and no child may read it (the same
 * wall as hidden/expected.json, harness/score.mjs); the parent reads it to
 * score an answer (harness/score-question.mjs).
 * Run: `node questions/generate.mjs` (writes) or `--check` (exit 1 on a difference).
 * Example: `{ "run-tax-rate": 6, … }`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BENCH_DIR } from '../harness/runtime.mjs';
import { malformed } from '../harness/shapes.mjs';
import { loadQuestions } from './index.mjs';
import { makeContext } from './observe.mjs';

export const ANSWERS_FILE = join(BENCH_DIR, 'hidden', 'answers.json');

/** @returns {Promise<Record<string, unknown>>} id → expected answer, sorted by id */
export async function computeAnswers() {
  const ctx = await makeContext();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const q of [...loadQuestions()].sort((a, b) => a.id.localeCompare(b.id))) {
    const answer = await q.derive(ctx);
    const bad = malformed(q.shape, answer);
    if (bad) throw new Error(`question ${q.id}: the computed answer ${JSON.stringify(answer)} is malformed (${bad})`);
    out[q.id] = answer;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const answers = await computeAnswers();
  const text = `${JSON.stringify(answers, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const same = isDeepStrictEqual(JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')), answers);
    console.log(same ? 'hidden/answers.json equals the computed answers' : 'hidden/answers.json DIFFERS from the computed answers');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(ANSWERS_FILE, text);
  console.log(`wrote ${Object.keys(answers).length} answers to hidden/answers.json`);
}
