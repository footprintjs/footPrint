/**
 * Runs `node` in a child process with hard limits: no shell, an empty
 * environment, a time limit, and a cap on the output kept.
 *
 * Why so strict: the code it runs is the agent's working copy, which the
 * agent may have edited. An empty environment keeps every secret of the
 * harness's own environment (an API key above all) out of reach of a
 * `console.log(process.env)`; the time limit stops an endless loop; the cap
 * stops a print in a loop from filling the model's context.
 * Example: `await runNode(['src/run-order.mjs', 'fixtures/a.json'], { cwd })`
 * → `{ code: 0, stdout: '{…}', stderr: '', timedOut: false, cut: false }`.
 */
import { spawn } from 'node:child_process';

/** Default limits; every caller may lower them, none may lift them past `MAX_*`. */
export const CHILD_LIMITS = Object.freeze({ timeoutMs: 20_000, maxOutputBytes: 200_000 });
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * @typedef {object} ChildResult
 * @property {number|null} code     exit code, null when killed
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut     the time limit killed it
 * @property {boolean} cut          output past the cap was dropped
 */

/**
 * @param {string[]} args arguments to `node`, never a shell line
 * @param {{ cwd: string, timeoutMs?: number, maxOutputBytes?: number }} options
 * @returns {Promise<ChildResult>}
 */
export function runNode(args, options) {
  const timeoutMs = Math.min(options.timeoutMs ?? CHILD_LIMITS.timeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxOutputBytes ?? CHILD_LIMITS.maxOutputBytes, MAX_OUTPUT_BYTES);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    /** @type {{ stdout: Buffer[], stderr: Buffer[] }} */
    const chunks = { stdout: [], stderr: [] };
    let kept = 0;
    let cut = false;
    let timedOut = false;
    const keep = (/** @type {'stdout'|'stderr'} */ name) => (/** @type {Buffer} */ data) => {
      const room = maxBytes - kept;
      if (room <= 0) {
        cut = true;
        return;
      }
      const part = data.length > room ? data.subarray(0, room) : data;
      if (part.length < data.length) cut = true;
      chunks[name].push(part);
      kept += part.length;
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (/** @type {number|null} */ code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut,
        cut,
      });
    };
    child.on('error', (error) => {
      chunks.stderr.push(Buffer.from(String(error)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
