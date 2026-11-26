/**
 * The consumer audit's command line (`scripts/audit-consumers.mjs`, whose header lists the flags): the
 * arguments in, `opts` out. A missing value, an unknown flag or a malformed value throws.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

import { parseCommit, parseShard } from './consumer-shards.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALUE_FLAGS = ['--only', '--candidate', '--org', '--base-version', '--shard', '--commit'];

export function parseArgs(argv) {
  const opts = {
    local: false,
    only: null,
    candidate: null,
    baseVersion: null,
    org: dirname(REPO_ROOT),
    apt: false,
    keep: false,
    shard: null,
    commit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--local') opts.local = true;
    else if (flag === '--apt') opts.apt = true;
    else if (flag === '--keep') opts.keep = true;
    else if (VALUE_FLAGS.includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      if (flag === '--only') opts.only = value.split(',');
      else if (flag === '--candidate') opts.candidate = resolve(value);
      else if (flag === '--base-version') {
        if (semver.valid(value) !== value) throw new Error(`--base-version is not a version: ${value.slice(0, 80)}`);
        opts.baseVersion = value;
      } else if (flag === '--shard') opts.shard = parseShard(value);
      else if (flag === '--commit') opts.commit = parseCommit(value);
      else opts.org = resolve(value);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}
