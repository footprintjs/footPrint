/**
 * The command line.
 *
 *   node harness/run.mjs --rehearse --out <folder>        scripted model, spends nothing
 *   node --env-file=<file> harness/run.mjs --out <folder> the paid batch (key from the environment)
 *
 * Options: `--setups 1,2,3` · `--faults <id,id>` · `--repeats N` (default 3) ·
 * `--seed N` · `--out <folder>` (required). Without `--rehearse` and without
 * `ANTHROPIC_API_KEY` in the environment it prints one sentence and exits 1;
 * it never reads a file to find a key. When the batch ends it writes
 * `report.md` beside `runs.jsonl`.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadFaults } from '../faults/apply.mjs';
import { runBatch, readRuns } from './batch.mjs';
import { anthropicModel, scriptedModel } from './model.mjs';
import { renderReport } from './report.mjs';
import { solver } from './scripts.mjs';

const { values } = parseArgs({
  options: {
    rehearse: { type: 'boolean', default: false },
    setups: { type: 'string', default: '1,2,3' },
    faults: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    seed: { type: 'string', default: '20261112' },
    out: { type: 'string' },
  },
});

if (!values.rehearse && !process.env.ANTHROPIC_API_KEY) {
  console.error('No ANTHROPIC_API_KEY in the environment: pass --rehearse, or start the paid batch with node --env-file=<file>.');
  process.exit(1);
}
if (!values.out) {
  console.error('Give an output folder with --out <folder>.');
  process.exit(2);
}
const out = resolve(values.out);
const setups = values.setups.split(',').map(Number);
if (setups.some((s) => ![1, 2, 3].includes(s))) {
  console.error('--setups takes 1, 2 and 3.');
  process.exit(2);
}
const all = loadFaults();
const wanted = values.faults ? values.faults.split(',') : all.map((f) => f.id);
const faults = all.filter((f) => wanted.includes(f.id));
if (faults.length !== wanted.length) {
  console.error(`Unknown fault id among: ${wanted.join(', ')}`);
  process.exit(2);
}
const repeats = Number(values.repeats);
const seed = Number(values.seed);

const result = await runBatch({
  out,
  setups,
  faults,
  repeats,
  seed,
  modelFor: values.rehearse ? async (setup, fault) => scriptedModel(solver(fault, setup)) : () => anthropicModel(),
  say: (line) => console.log(line),
});
const title = values.rehearse ? 'agent-debug rehearsal (scripted model, spends nothing)' : 'agent-debug report';
writeFileSync(join(out, 'report.md'), renderReport(readRuns(join(out, 'runs.jsonl')), { title }));
console.log(`report: ${join(out, 'report.md')}${result.stoppedBySpend ? ' (the batch stopped at the spend limit)' : ''}`);
