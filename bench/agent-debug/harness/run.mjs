/**
 * The command line.
 *
 *   node harness/run.mjs --rehearse --out <folder>        scripted model, spends nothing
 *   node harness/run.mjs --smoke --out <folder>           the smoke batch: wrong-key-read, once per set-up
 *   node harness/run.mjs --out <folder>                   the paid batch
 *
 * The paid and smoke batches need `ANTHROPIC_API_KEY` in the environment of
 * that one command, and only that variable (RULE.md, rule 7). Without
 * `--rehearse` and without it, the command prints one sentence and exits 1;
 * it never reads a file to find a key.
 * Options: `--setups 1,2,3` · `--faults <id,id>` · `--repeats N` (default 3) ·
 * `--seed N` · `--out <folder>` (required). `--smoke` refuses `--faults`,
 * `--repeats` and `--setups`: its runs are fixed by RULE.md 1.2. When the
 * batch ends it writes `report.md` beside `runs.jsonl`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadFaults } from '../faults/apply.mjs';
import { runBatch, readRuns } from './batch.mjs';
import { anthropicModel, scriptedModel } from './model.mjs';
import { renderReport } from './report.mjs';
import { solver } from './scripts.mjs';

/** RULE.md 1.2: the smoke batch is this fault, once in each set-up. */
export const SMOKE = Object.freeze({ fault: 'wrong-key-read', setups: [1, 2, 3], repeats: 1 });
export const NO_KEY_SENTENCE =
  'The paid batch needs ANTHROPIC_API_KEY in the environment of this one command, and only that variable; or pass --rehearse.';

const { values } = parseArgs({
  options: {
    rehearse: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    setups: { type: 'string' },
    faults: { type: 'string' },
    repeats: { type: 'string' },
    seed: { type: 'string', default: '20261112' },
    out: { type: 'string' },
  },
});

const refuse = (/** @type {string} */ sentence, code = 2) => {
  console.error(sentence);
  process.exit(code);
};

if (values.smoke && (values.faults !== undefined || values.repeats !== undefined || values.setups !== undefined)) {
  refuse('--smoke runs the fault wrong-key-read once in each set-up; it takes no --faults, --repeats or --setups.');
}
if (!values.rehearse && !process.env.ANTHROPIC_API_KEY) refuse(NO_KEY_SENTENCE, 1);
if (!values.out) refuse('Give an output folder with --out <folder>.');

const out = resolve(/** @type {string} */ (values.out));
const setups = values.smoke ? SMOKE.setups : (values.setups ?? '1,2,3').split(',').map(Number);
if (setups.some((s) => ![1, 2, 3].includes(s))) refuse('--setups takes 1, 2 and 3.');
const all = loadFaults();
const wanted = values.smoke ? [SMOKE.fault] : values.faults ? values.faults.split(',') : all.map((f) => f.id);
const faults = all.filter((f) => wanted.includes(f.id));
if (faults.length !== wanted.length) refuse(`Unknown fault id among: ${wanted.join(', ')}`);
const repeats = values.smoke ? SMOKE.repeats : Number(values.repeats ?? 3);
const seed = Number(values.seed);

const result = await runBatch({
  out,
  setups,
  faults,
  repeats,
  seed,
  label: values.smoke ? 'smoke' : 'batch',
  modelFor: values.rehearse ? async (setup, fault) => scriptedModel(solver(fault, setup)) : () => anthropicModel(),
  say: (line) => console.log(line),
});
const kind = values.rehearse ? 'rehearsal (scripted model, spends nothing)' : 'report';
const title = values.smoke
  ? `agent-debug smoke batch${values.rehearse ? ', rehearsed' : ''}: three runs of wrong-key-read, NOT part of the result`
  : `agent-debug ${kind}`;
const order = JSON.parse(readFileSync(join(out, 'order.json'), 'utf8'));
writeFileSync(join(out, 'report.md'), renderReport(readRuns(join(out, 'runs.jsonl')), { title, plan: order.plan, smoke: order.label === 'smoke' }));
console.log(`report: ${join(out, 'report.md')}${result.stoppedBySpend ? ' (the batch stopped at the spend limit)' : ''}`);
