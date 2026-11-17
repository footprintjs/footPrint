/** CLI boundary: no plan never changes the ordinary audit; present-but-bad always refuses. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from '../audit-process.mjs';
import { runCohort } from './index.mjs';
import { admitPlan, hash, recipes, verifyHead } from './plan/index.mjs';
import { produce } from './pack/index.mjs';
import { auditPaired } from './audit/index.mjs';
import { verifyBundle } from './bytes/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, folderArg, consumer] = process.argv.slice(2);
const folder = resolve(folderArg ?? '.');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const planFile = join(root, 'scripts/consumer-cohort.json');
try {
  if (!['pack', 'audit'].includes(mode) || !folderArg || (mode === 'audit' && !consumer))
    throw new Error('invalid cohort operation');
  if (!existsSync(planFile)) {
    if (mode === 'audit') throw new Error('paired audit needs a complete plan');
    console.log('No source-cohort plan; ordinary consumer audit unchanged.');
  } else {
    const planBytes = readFileSync(planFile);
    const context = json(join(folder, 'source-context.json'));
    if (
      context.repo !== 'footprintjs/footPrint' ||
      context.checkout !== process.env.GITHUB_SHA ||
      context.checkout !== read('git', ['rev-parse', 'HEAD'], root) ||
      context.tree !== read('git', ['rev-parse', 'HEAD^{tree}'], root) ||
      context.run !== process.env.GITHUB_RUN_ID ||
      context.attempt !== process.env.GITHUB_RUN_ATTEMPT ||
      context.planHash !== hash(planBytes) ||
      read('git', ['rev-parse', 'HEAD:scripts/consumer-cohort.json'], root) !==
        read('git', ['hash-object', planFile], root) ||
      JSON.stringify(context.manifest) !==
        JSON.stringify(JSON.parse(read('git', ['show', `${context.checkout}:package.json`], root)))
    )
      throw new Error('source/plan/run changed after pre-build observation');
    const { family } = json(join(root, 'scripts/family.json'));
    const input = {
      mode,
      folder,
      root,
      family,
      planBytes,
      context,
      consumer,
      receipt: mode === 'audit' ? json(join(folder, 'cohort.json')) : null,
    };
    const state = await runCohort(input, { admitPlan, recipes, verifyHead, produce, auditPaired, verifyBundle });
    const result = mode === 'audit' ? state.result : { completed: state.completed };
    console.log(JSON.stringify({ planHash: hash(planBytes), context, result }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nSource cohort ${hash(planBytes)}: ${mode} ${result.verdict ?? 'complete'} at ${context.head}; checkout ${
          context.checkout
        }; run ${context.run}/${context.attempt}.\n`,
      );
    if (mode === 'audit' && result.verdict !== 'pass') process.exitCode = 1;
  }
} catch (error) {
  console.error(`Source cohort BLOCKING (no complete compatibility verdict): ${error.message}`);
  process.exitCode = 1;
}
