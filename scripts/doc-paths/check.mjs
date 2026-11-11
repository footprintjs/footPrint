#!/usr/bin/env node
/**
 * check.mjs: every repo path a tracked Markdown or MDX doc names exists.
 *
 *   node scripts/doc-paths/check.mjs [--root <dir>]
 *
 * Prints one line per problem, `file:line: path`, and exits 1 when there is one. The rule lives in
 * `paths.mjs`; this file only reads `git ls-files` and the docs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isolatedGitEnv } from '../git-env.mjs';
import { findProblems, formatProblem } from './paths.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The tracked files of the repository at `root`. */
export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    env: isolatedGitEnv(),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);
}

/** Every stale path in the repository at `root`. */
export function checkRepository(root) {
  return findProblems(trackedFiles(root), (file) => readFileSync(join(root, file), 'utf8'));
}

function main(args) {
  const at = args.indexOf('--root');
  const root = at >= 0 ? resolve(args[at + 1]) : REPO_ROOT;
  const problems = checkRepository(root);
  for (const problem of problems) console.error(formatProblem(problem));
  console.log(`check:doc-paths: ${problems.length ? `FAIL (${problems.length} missing paths)` : 'OK'}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
