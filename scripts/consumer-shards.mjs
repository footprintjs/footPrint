#!/usr/bin/env node
/**
 * consumer-shards.mjs — one consumer's test suite split across jobs, as data in `scripts/family.json`.
 *
 * WHY: agentfootprint's suite (about 34,000 tests) ran in ONE consumer job for 40–50 minutes, the long
 * pole of every engine pull request, while its own CI runs the same suite in four shards.
 *
 * An entry opts in with `"shards": { "check": "npm test", "count": 4 }`. Each shard job runs the WHOLE
 * audit of that consumer (clone, install, the peer and range audit, every check, the published leg and
 * the second candidate run when they apply), with that one check narrowed to its share of the test
 * files: `npm test -- --shard=i/N`, the flag of vitest and of jest. Every shard installs for itself:
 * about 20 s for agentfootprint (clone 4, `npm ci` 14, install footprintjs 2; Consumers run
 * 43261862232), less than moving an installed tree between jobs, and the second candidate run needs a
 * fresh tree anyway.
 *
 * ONE COMMIT: every shard of one consumer audits the same consumer commit, read once by the `pack` job
 * (`pinShards`). Each job clones on its own, and a branch that moved between two clones would hand the
 * shards different file lists: a test file could run twice, or never.
 *
 * `.github/workflows/consumers.yml` makes the jobs from `consumerJobs`: one per unsharded consumer, named
 * for it; one per shard, `<consumer> · shard i/N`; and one aggregate per sharded consumer, named for it,
 * green only when `pack` and every shard job succeeded. docs/guides/consumer-audit.md, "A suite in shards".
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { read } from './audit-process.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_SHARDS = 16;
/** An npm script with no arguments of its own, so `-- --shard=i/N` reaches its test runner. */
const NPM_SCRIPT = /^npm (?:test|run [A-Za-z0-9:._-]+)$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** An entry's shard plan, `{ check, count }`, or null when it declares none. A malformed plan throws. */
export function shardsOf(entry) {
  const plan = entry.shards;
  if (plan === undefined) return null;
  const where = `${entry.package}: shards`;
  const keys = plan && typeof plan === 'object' && !Array.isArray(plan) ? Object.keys(plan).sort().join() : '';
  if (keys !== 'check,count')
    throw new Error(`${where} must be { "check": <one of its checks>, "count": <2 to ${MAX_SHARDS}> }`);
  const { check, count } = plan;
  if (!Number.isInteger(count) || count < 2 || count > MAX_SHARDS)
    throw new Error(`${where}.count must be a whole number from 2 to ${MAX_SHARDS}`);
  if (!(entry.checks ?? []).includes(check)) throw new Error(`${where}.check must be one of its checks`);
  if (!NPM_SCRIPT.test(check))
    throw new Error(`${where}.check must be \`npm test\` or \`npm run <name>\`: its runner gets \`-- --shard=i/N\``);
  // Only the consumer's own checkout is pinned to one commit; a sibling cloned by each shard is not.
  if (entry.siblings?.length) throw new Error(`${where}: a consumer with siblings cannot be sharded`);
  return { check, count };
}

/** `i/N` as `{ index, count }`, with 1 ≤ i ≤ N and 2 ≤ N ≤ MAX_SHARDS; anything else throws. */
export function parseShard(value) {
  const match = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(String(value));
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || index > count || count < 2 || count > MAX_SHARDS)
    throw new Error(`--shard is not i/N (1 ≤ i ≤ N, 2 ≤ N ≤ ${MAX_SHARDS}): ${String(value).slice(0, 40)}`);
  return { index, count };
}

/** A full, lower-case commit SHA, or it throws. */
export function parseCommit(value) {
  if (!COMMIT.test(String(value))) throw new Error(`--commit is not a full commit SHA: ${String(value).slice(0, 80)}`);
  return value;
}

/** The command one shard runs in place of its entry's sharded check. */
export const shardCommand = (check, { index, count }) => `${check} -- --shard=${index}/${count}`;

/**
 * The entries one audit run audits, given `--shard` and `--commit` (`opts.shard`, `opts.commit`). Without
 * either, `entries` unchanged. With them: exactly one consumer, its own checkout at that commit (`clone`
 * reads `commit` from the entry), and with `--shard` its sharded check narrowed to that shard. A shard
 * needs the commit: it is one part of one suite run, and the parts must be of one commit.
 */
export function narrowAudit(entries, { shard = null, commit = null } = {}) {
  if (!shard && !commit) return entries;
  if (entries.length !== 1) throw new Error('--shard and --commit audit one consumer: name it with --only');
  const [entry] = entries;
  if (!shard) return [{ ...entry, commit }];
  const plan = shardsOf(entry);
  if (!plan) throw new Error(`--shard: ${entry.package} declares no shards in scripts/family.json`);
  if (shard.count !== plan.count)
    throw new Error(`--shard ${shard.index}/${shard.count}: ${entry.package} declares ${plan.count} shards`);
  if (!commit) throw new Error('--shard needs --commit: every shard of one suite must audit the same commit');
  const checks = entry.checks.map((check) => (check === plan.check ? shardCommand(check, shard) : check));
  return [{ ...entry, commit, checks }];
}

/**
 * The consumer jobs, from the family list: `consumers` (one job each, unsharded), `shards` (one row per
 * shard: `{ consumer, shard: 'i/N' }`) and `sharded` (one aggregate each). Every entry with `checks` is
 * in exactly one of `consumers` and `sharded`.
 */
export function consumerJobs(family) {
  const plans = family.filter((entry) => entry.checks).map((entry) => [entry.package, shardsOf(entry)]);
  return {
    consumers: plans.filter(([, plan]) => !plan).map(([name]) => name),
    shards: plans.flatMap(([consumer, plan]) =>
      plan ? Array.from({ length: plan.count }, (_, i) => ({ consumer, shard: `${i + 1}/${plan.count}` })) : [],
    ),
    sharded: plans.filter(([, plan]) => plan).map(([name]) => name),
  };
}

/** Every shard row with its consumer's commit: `headOf(entry)` asked once per sharded consumer. */
export function pinShards(jobs, family, headOf) {
  const commits = new Map(
    jobs.sharded.map((name) => [name, parseCommit(headOf(family.find((entry) => entry.package === name)))]),
  );
  return { ...jobs, shards: jobs.shards.map((row) => ({ ...row, commit: commits.get(row.consumer) })) };
}

/** The commit a consumer's branch stands at on GitHub now: exactly one ref line and a full SHA, or it throws. */
export function remoteHead({ repo, branch }, readCommand = read) {
  const ref = `refs/heads/${branch}`;
  const out = readCommand('git', ['ls-remote', '--exit-code', `https://github.com/${repo}.git`, ref]);
  const lines = out.split('\n').filter(Boolean);
  const [sha, name] = lines.length === 1 ? lines[0].split('\t') : [];
  if (name !== ref || !COMMIT.test(sha ?? '')) throw new Error(`could not read ${repo} ${ref}: ${out.slice(0, 200)}`);
  return sha;
}

/** The `pack` job's step: the plan, pinned, as `$GITHUB_OUTPUT` lines (one JSON value per line). */
export function main(services = {}) {
  const io = {
    family: () => JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/family.json'), 'utf8')).family,
    headOf: remoteHead,
    ...services,
  };
  const family = io.family();
  const jobs = pinShards(consumerJobs(family), family, io.headOf);
  return Object.entries(jobs)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
    .join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(main());
