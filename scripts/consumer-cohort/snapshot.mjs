/** Builtins only. Runs immediately after checkout/base read, before npm or package code. */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const checkout = git('rev-parse', 'HEAD');
const parents = git('cat-file', '-p', 'HEAD')
  .split('\n\n')[0]
  .split('\n')
  .filter((line) => line.startsWith('parent '))
  .map((line) => line.slice(7));
const pr = event.pull_request;
const head = pr?.head?.sha ?? checkout;
const base = pr?.base?.sha ?? checkout;
if (
  process.env.GITHUB_REPOSITORY !== 'footprintjs/footPrint' ||
  checkout !== process.env.GITHUB_SHA ||
  ![head, base, checkout].every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
  (pr && (parents.length !== 2 || parents[0] !== base || parents[1] !== head))
)
  throw new Error('source event/actual checkout join differs');
const planFile = 'scripts/consumer-cohort.json';
const context = {
  repo: process.env.GITHUB_REPOSITORY,
  head,
  base,
  checkout,
  parents,
  tree: git('rev-parse', 'HEAD^{tree}'),
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  manifest: JSON.parse(git('show', `${checkout}:package.json`)),
  planHash: existsSync(planFile) ? createHash('sha256').update(readFileSync(planFile)).digest('hex') : null,
};
writeFileSync(process.argv[2], `${JSON.stringify(context, null, 2)}\n`);
