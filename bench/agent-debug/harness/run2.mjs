/**
 * The command line of part 2 (RULE-2.md). Part 1's is harness/run.mjs, unchanged.
 *
 *   node --disable-sigusr1 harness/run2.mjs --rehearse --out <folder>   scripted model, spends nothing
 *   node --disable-sigusr1 harness/run2.mjs --smoke --out <folder>      the smoke batch: 16 runs
 *   node --disable-sigusr1 harness/run2.mjs --out <folder>              the paid batch: 800 runs
 *
 * Options: `--setups P,1,2,3` · `--tasks <id,id>` (questions and faults) ·
 * `--repeats N` (default 5) · `--seed N` · `--out <folder>` (required).
 * `--smoke` refuses `--tasks`, `--repeats` and `--setups`: its runs are fixed
 * (harness/plan2.mjs). Set-up P is refused by name while the twin is not
 * built, and so is any plan that includes it, before anything runs.
 * Like run.mjs: `--disable-sigusr1` is required (exit 2 without it), and the
 * paid and smoke batches need `ANTHROPIC_API_KEY` in the environment of
 * this one command (exit 1 without it); no file is read to find a key.
 * The rehearsal's scripts: a fault is solved (scripts.mjs · solver); a
 * question is answered right, answered wrong, or never answered, by its
 * place in the list (plan2.mjs · rehearsalScriptFor).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadFaults } from '../faults/apply.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { runBatch } from './batch.mjs';
import { anthropicModel, scriptedModel } from './model.mjs';
import { PART2, rehearsalScriptFor } from './plan2.mjs';
import { parseSetup } from './programs.mjs';
import { SYSTEM_PROMPT_2 } from './prompt.mjs';
import { Refusal } from './refusal.mjs';
import { writeReport2 } from './report2.mjs';
import { expectedAnswers } from './score-question.mjs';
import { answerer, solver, talker, wrongAnswerer } from './scripts.mjs';
import { FLAG, sigusr1Check } from './sigusr1.mjs';

export const NO_KEY_SENTENCE =
  'The paid batch needs ANTHROPIC_API_KEY in the environment of this one command, and only that variable; or pass --rehearse.';

const refuse = (/** @type {string} */ sentence, code = 2) => {
  console.error(sentence);
  process.exit(code);
};
const sentence = (/** @type {string} */ text) => `${text[0].toUpperCase()}${text.slice(1)}`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      rehearse: { type: 'boolean', default: false },
      smoke: { type: 'boolean', default: false },
      setups: { type: 'string' },
      tasks: { type: 'string' },
      repeats: { type: 'string' },
      seed: { type: 'string', default: String(PART2.seed) },
      out: { type: 'string' },
    },
  }));
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}

const signalCheck = sigusr1Check();
if (!signalCheck.ok) refuse(`Start the harness with node ${FLAG} harness/run2.mjs … and no other sigusr1 option (RULE.md, rule 8): ${signalCheck.reason}.`);
if (values.smoke && (values.tasks !== undefined || values.repeats !== undefined || values.setups !== undefined)) {
  refuse('--smoke runs one question of each kind and the fault wrong-key-read once in each set-up; it takes no --tasks, --repeats or --setups.');
}
if (!values.rehearse && !process.env.ANTHROPIC_API_KEY) refuse(NO_KEY_SENTENCE, 1);
if (!values.out) refuse('Give an output folder with --out <folder>.');

const out = resolve(/** @type {string} */ (values.out));
let setups;
try {
  setups = values.smoke ? [...PART2.smoke.setups] : values.setups ? values.setups.split(',').map(parseSetup) : [...PART2.setups];
} catch (error) {
  refuse(sentence(error instanceof Error ? error.message : String(error)));
}
const allQuestions = loadQuestions();
const allFaults = loadFaults();
const wanted = values.smoke ? [...PART2.smoke.questions, ...PART2.smoke.faults] : values.tasks ? values.tasks.split(',') : [...allQuestions, ...allFaults].map((t) => t.id);
const questions = allQuestions.filter((q) => wanted.includes(q.id));
const faults = allFaults.filter((f) => wanted.includes(f.id));
if (questions.length + faults.length !== new Set(wanted).size) refuse(`Unknown task id among: ${wanted.join(', ')}`);
const repeats = values.smoke ? PART2.smoke.repeats : Number(values.repeats ?? PART2.repeats);

/** The rehearsal's stand-in for one run. */
function rehearsalModel(setup, task) {
  if (task.type !== 'question') return scriptedModel(solver(task, setup));
  const answer = expectedAnswers()[task.id];
  const script = rehearsalScriptFor(allQuestions.findIndex((q) => q.id === task.id));
  if (script === 'right') return scriptedModel(answerer(task, answer, setup));
  if (script === 'wrong') return scriptedModel(wrongAnswerer(task, answer, setup));
  return scriptedModel(talker());
}

let result;
try {
  result = await runBatch({
    out, setups, faults, questions, repeats, seed: Number(values.seed), label: values.smoke ? 'smoke' : 'batch', system: SYSTEM_PROMPT_2,
    modelFor: values.rehearse ? async (setup, task) => rehearsalModel(setup, task) : () => anthropicModel(),
    say: (line) => console.log(line),
  });
} catch (error) {
  // A refusal (set-up P without the twin, a locked folder, a program that does
  // not match its manifest, other flags) is one sentence and exit 2.
  if (error instanceof Refusal) refuse(sentence(error.message));
  throw error;
}
const runsCount = setups.length * (questions.length + faults.length) * repeats;
const title = values.smoke
  ? `agent-debug part 2 smoke batch${values.rehearse ? ', rehearsed' : ''}: ${runsCount} runs, NOT part of the result`
  : `agent-debug part 2 ${values.rehearse ? 'rehearsal (scripted model, spends nothing)' : 'report'}`;
writeReport2(out, title);
console.log(`report: ${out}/report.md${result.stoppedBySpend ? ' (the batch stopped at the spend limit)' : ''}`);
