/**
 * Runs `node` in a CONFINED child process: Node's permission model, no shell,
 * an empty environment, a time limit, and a cap on the output kept.
 *
 * Why: the code a child runs is the agent's working copy, which a model may
 * have edited, on the owner's machine. Confinement:
 * - the permission model (`--permission` on Node 24, `--experimental-permission`
 *   on older 22 lines): the child may READ only the folders the caller names
 *   (the working copy and the runtime folder) and WRITE only the ones it names
 *   (the working copy, or nothing); it may start no child process, no worker
 *   and no native addon. If the running Node has no permission model, this
 *   module REFUSES to start a child: there is no unconfined fallback.
 * - an empty environment, so an API key in the harness's environment never
 *   reaches a `console.log(process.env)`;
 * - a time limit (an endless loop) and an output cap (a print in a loop).
 * NOT confined: the network. Node's permission model on these versions does
 * not restrict sockets. With nothing readable outside the working copy and
 * the published libraries, there is nothing secret to send.
 * Example: `await runNode(['src/run-order.mjs', 'fixtures/a.json'], { cwd, confine: { read: [cwd, runtime], write: [cwd] } })`
 * → `{ code: 0, stdout: '{…}', stderr: '', timedOut: false, cut: false }`.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Default limits; a caller may lower them, none may lift them past `MAX_*`. */
export const CHILD_LIMITS = Object.freeze({ timeoutMs: 20_000, maxOutputBytes: 200_000 });
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2_000_000;

/** The permission flag of the running Node, or undefined when it has none. */
export function permissionFlag() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return undefined;
}

/**
 * The flags that confine a child to `read` and `write` (absolute folders or files).
 * @param {{ read: string[], write: string[] }} confine
 */
export function confinementArgs(confine) {
  const flag = permissionFlag();
  if (!flag) throw new Error('this Node has no permission model; refusing to run working-copy code unconfined');
  const real = (/** @type {string} */ p) => {
    if (!isAbsolute(p)) throw new Error(`confinement paths must be absolute: ${p}`);
    return realpathSync(p);
  };
  return [
    flag,
    ...confine.read.map((p) => `--allow-fs-read=${real(p)}`),
    ...confine.write.map((p) => `--allow-fs-write=${real(p)}`),
  ];
}

/**
 * @typedef {object} ChildResult
 * @property {number|null} code     exit code, null when killed
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut     the time limit killed it
 * @property {boolean} cut          output past the cap was dropped
 */

/**
 * @param {string[]} args arguments to `node` after the confinement flags, never a shell line
 * @param {{ cwd: string, confine: { read: string[], write: string[] }, timeoutMs?: number, maxOutputBytes?: number }} options
 * @returns {Promise<ChildResult>}
 */
export function runNode(args, options) {
  if (!options || !options.confine) return Promise.reject(new Error('every child must declare what it may read and write'));
  let flags;
  try {
    flags = confinementArgs(options.confine);
  } catch (error) {
    return Promise.reject(error);
  }
  const timeoutMs = Math.min(options.timeoutMs ?? CHILD_LIMITS.timeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxOutputBytes ?? CHILD_LIMITS.maxOutputBytes, MAX_OUTPUT_BYTES);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, ...args], {
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
    let settled = false;
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
      if (settled) return;
      settled = true;
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
