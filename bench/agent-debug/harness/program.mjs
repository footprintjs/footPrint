/**
 * Runs a copy of the program, or a test file in it, in a child process
 * (harness/child.mjs) with the libraries from the runtime folder.
 *
 * One owner for "how the program is run" for the agent's tools (`run_order`,
 * `run_tests`) and the fault tests. Every child is confined (child.mjs).
 * Example: `await runTestFile(dir, 'test/visible.test.mjs')`
 * → `{ passed: ['a small order …'], failed: [], details: {}, … }`.
 */
import { runNode } from './child.mjs';
import { ensureRuntime, importHookArgs } from './runtime.mjs';

/**
 * What a child that runs a working copy may touch: read the copy and the
 * runtime folder, write the copy only.
 * @param {string} dir
 */
export function workingCopyConfinement(dir) {
  return { read: [dir, ensureRuntime()], write: [dir] };
}

/**
 * Runs the program on one fixture and returns the child's output.
 * @param {string} dir a working copy
 * @param {string} fixture a fixture name, already checked by the caller
 * @param {{ timeoutMs?: number, maxOutputBytes?: number }} [limits]
 */
export function runOrderIn(dir, fixture, limits = {}) {
  return runNode([...importHookArgs(), 'src/run-order.mjs', `fixtures/${fixture}.json`], {
    cwd: dir,
    confine: workingCopyConfinement(dir),
    ...limits,
  });
}

/**
 * Reads the program's final result from `run-order.mjs`'s output: the last
 * top-level JSON object printed on stdout.
 * @param {string} stdout
 * @returns {Record<string, unknown> | undefined}
 */
export function parseResult(stdout) {
  const start = stdout.lastIndexOf('\n{\n') >= 0 ? stdout.lastIndexOf('\n{\n') + 1 : stdout.startsWith('{\n') ? 0 : -1;
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * @typedef {object} TestRun
 * @property {string[]} passed
 * @property {string[]} failed
 * @property {Record<string, string>} details failure text by test name
 * @property {boolean} timedOut
 * @property {boolean} cut
 * @property {number|null} code
 * @property {string} stderr
 */

/**
 * Runs one `node:test` file in a copy and reads its TAP report.
 * @param {string} dir
 * @param {string} file relative to `dir`
 * @param {{ timeoutMs?: number }} [limits]
 * @returns {Promise<TestRun>}
 */
export async function runTestFile(dir, file, limits = {}) {
  const child = await runNode(
    [...importHookArgs(), '--test', '--test-isolation=none', '--test-reporter=tap', file],
    { cwd: dir, confine: workingCopyConfinement(dir), timeoutMs: limits.timeoutMs ?? 60_000 },
  );
  return { ...parseTap(child.stdout), timedOut: child.timedOut, cut: child.cut, code: child.code, stderr: child.stderr };
}

/**
 * Reads top-level `ok` / `not ok` lines of a TAP report and the YAML block
 * under each failure.
 * @param {string} tap
 */
export function parseTap(tap) {
  /** @type {string[]} */ const passed = [];
  /** @type {string[]} */ const failed = [];
  /** @type {Record<string, string>} */ const details = {};
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(not ok|ok) \d+ - (.*?)(?: # .*)?$/.exec(lines[i]);
    if (!match) continue;
    const name = match[2].replace(/\\#/g, '#');
    if (match[1] === 'ok') {
      passed.push(name);
      continue;
    }
    failed.push(name);
    const block = [];
    for (let j = i + 1; j < lines.length && /^ {2}/.test(lines[j]); j++) block.push(lines[j].slice(2));
    details[name] = block.join('\n');
  }
  return { passed, failed, details };
}
