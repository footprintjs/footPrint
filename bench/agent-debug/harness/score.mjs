/**
 * Scores a finished run: did the agent's edit fix the fault?
 *
 * The hidden tests are never copied into the working folder. They run in a
 * SEPARATE scoring folder: a fresh copy of the original program (its own
 * fixtures and tests), the working folder's `src/` laid over it, and the
 * hidden test file beside them. So nothing the agent did outside `src/` can
 * touch the judgement, and the agent could never have read the judge.
 * Solved (RULE.md): every hidden test passes, and no file outside `src/` changed.
 * Example: `await scoreRun(workdir, startManifest, fault)` →
 * `{ solved: true, hiddenFailed: [], changedOutsideSrc: [], editedFiles: ['src/steps/grand-total/index.mjs'], … }`.
 */
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BENCH_DIR } from './runtime.mjs';
import { runTestFile } from './program.mjs';
import { createWorkdir, manifestOf, removeWorkdir } from './workdir.mjs';

export const HIDDEN_TEST = join(BENCH_DIR, 'hidden', 'hidden.test.mjs');

/**
 * Runs the hidden tests against the `src/` of `workdir`.
 * @param {string} workdir
 * @returns {Promise<import('./program.mjs').TestRun>}
 */
export async function runHiddenTests(workdir) {
  const scoring = await createWorkdir(null, { prefix: 'agent-debug-score-' });
  try {
    rmSync(join(scoring.dir, 'src'), { recursive: true, force: true });
    cpSync(join(workdir, 'src'), join(scoring.dir, 'src'), { recursive: true, dereference: false });
    cpSync(HIDDEN_TEST, join(scoring.dir, 'test', 'hidden.test.mjs'));
    return await runTestFile(scoring.dir, 'test/hidden.test.mjs');
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
  const hidden = await runHiddenTests(workdir);
  const hiddenOk = hidden.failed.length === 0 && hidden.passed.length > 0 && !hidden.timedOut;
  return {
    solved: hiddenOk && changedOutsideSrc.length === 0,
    hiddenPassed: hidden.passed.length,
    hiddenFailed: hidden.failed,
    hiddenTimedOut: hidden.timedOut,
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
