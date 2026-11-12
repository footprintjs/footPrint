/**
 * Scores a finished run: did the agent's edit fix the fault?
 *
 * The child computes, the parent judges. The scored copy is a fresh copy of
 * the original program with the working folder's `src/` laid over it and
 * the hidden ORDERS (inputs only) beside it. A confined, read-only child
 * (harness/scoring-child/run-orders.mjs) runs each order and prints one JSON
 * document of results. This process compares them with `hidden/expected.json`,
 * which never enters a child. Edited code can change the reporter, exit early
 * or print anything: it still cannot pass without producing the right results.
 * Solved: exit code 0, output not cut, exactly one results document, exactly
 * the expected order names, every result equal to its expected value, and no
 * file outside `src/` changed.
 * Example: `await scoreRun(workdir, startManifest, fault)` →
 * `{ solved: true, wrongFixtures: [], changedOutsideSrc: [], editedFiles: ['src/steps/grand-total/index.mjs'], … }`.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { runNode } from './child.mjs';
import { BENCH_DIR, ensureRuntime, importHookArgs } from './runtime.mjs';
import { manifestOf, placedFolder, PROGRAM_DIR, removeWorkdir } from './workdir.mjs';

const HIDDEN_DIR = join(BENCH_DIR, 'hidden');
const MARKER = '\u0000agent-debug-scoring-results\u0000';

/** @returns {Record<string, unknown>} */
export function hiddenOrders() {
  return JSON.parse(readFileSync(join(HIDDEN_DIR, 'orders.json'), 'utf8'));
}

/** @returns {Record<string, unknown>} */
function expectedResults() {
  return JSON.parse(readFileSync(join(HIDDEN_DIR, 'expected.json'), 'utf8'));
}

/**
 * Reads the child's output into results, or says why it cannot be trusted.
 * @param {import('./child.mjs').ChildResult} child
 * @returns {{ results?: Record<string, unknown>, problem?: string }}
 */
export function readResults(child) {
  if (child.timedOut) return { problem: 'the scoring run hit its time limit' };
  if (child.cut) return { problem: 'the scoring run printed more than the cap' };
  if (child.code !== 0) return { problem: `the scoring run exited with code ${child.code}` };
  const parts = child.stdout.split(MARKER);
  if (parts.length !== 2) return { problem: `expected one results document, found ${parts.length - 1}` };
  try {
    const doc = JSON.parse(parts[1].trim());
    if (typeof doc !== 'object' || doc === null || typeof doc.results !== 'object' || doc.results === null) {
      return { problem: 'the results document has no results' };
    }
    return { results: doc.results };
  } catch {
    return { problem: 'the results document is not JSON' };
  }
}

/**
 * Compares results with the expected values; the comparison never runs in a child.
 * @param {Record<string, unknown> | undefined} results
 * @returns {{ wrong: string[], missing: string[], extra: string[] }}
 */
export function compareWithExpected(results) {
  const expected = expectedResults();
  const names = Object.keys(expected);
  if (!results) return { wrong: names, missing: names, extra: [] };
  const got = Object.keys(results);
  const missing = names.filter((n) => !Object.hasOwn(results, n));
  const extra = got.filter((n) => !Object.hasOwn(expected, n));
  const wrong = names.filter((n) => !Object.hasOwn(results, n) || !isDeepStrictEqual(results[n], expected[n]));
  return { wrong, missing, extra };
}

/**
 * Runs the hidden orders against the `src/` of `workdir` and judges them.
 * @param {string} workdir
 */
/**
 * The scoring copy: the original program, the working folder's `src/` laid
 * over it, and the hidden orders (inputs only), placed like a working copy
 * (workdir.mjs · placeCopy) so that no file time tells one copy from another.
 * @param {string} workdir
 * @returns {Promise<string>}
 */
export function buildScoringCopy(workdir) {
  return placedFolder('score-', (staging) => {
    cpSync(PROGRAM_DIR, staging, { recursive: true });
    rmSync(join(staging, 'src'), { recursive: true, force: true });
    cpSync(join(workdir, 'src'), join(staging, 'src'), { recursive: true });
    writeFileSync(join(staging, 'hidden-orders.json'), JSON.stringify(hiddenOrders()));
  });
}

export async function judgeCopy(workdir) {
  const scoring = { dir: await buildScoringCopy(workdir) };
  try {
    const ordersFile = join(scoring.dir, 'hidden-orders.json');
    const script = join(ensureRuntime(), 'scoring', 'run-orders.mjs');
    const child = await runNode([...importHookArgs(), script, scoring.dir, ordersFile], {
      cwd: scoring.dir,
      confine: { read: [scoring.dir, ensureRuntime()], write: [] },
      timeoutMs: 60_000,
    });
    const read = readResults(child);
    const compared = compareWithExpected(read.results);
    const passed = !read.problem && compared.wrong.length === 0 && compared.missing.length === 0 && compared.extra.length === 0;
    return { passed, problem: read.problem, ...compared, results: read.results };
  } finally {
    removeWorkdir(scoring.dir);
  }
}

/** Files added, removed or changed between two manifests. */
export function changedFiles(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

/**
 * @param {string} workdir the agent's working folder after the run
 * @param {Record<string, string>} startManifest its manifest when the run began
 * @param {import('../faults/apply.mjs').Fault} fault
 * @param {string} [namedStep] the step the agent's `done` summary names, if any
 */
export async function scoreRun(workdir, startManifest, fault, namedStep) {
  const changed = changedFiles(startManifest, manifestOf(workdir));
  const changedOutsideSrc = changed.filter((name) => !name.startsWith('src/'));
  const editedFiles = changed.filter((name) => name.startsWith('src/'));
  const judged = await judgeCopy(workdir);
  return {
    solved: judged.passed && changedOutsideSrc.length === 0,
    wrongFixtures: judged.wrong,
    scoringProblem: judged.problem ?? null,
    changedOutsideSrc,
    editedFiles,
    editedFaultyFile: editedFiles.includes(fault.file),
    namedFaultyStep: namedStep === undefined ? false : namesStep(namedStep, fault.stepAddress),
  };
}

/**
 * Whether a `done` summary names the faulty step: its address appears as a
 * whole word (`tax` in "the tax mapper", not in "taxRate").
 * @param {string} summary @param {string} address
 */
export function namesStep(summary, address) {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}($|[^A-Za-z0-9-])`, 'i').test(summary);
}
