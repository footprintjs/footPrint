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
 * @typedef {{ head: string, tail: string, dropped: number }} Ends the start and the end of a stream, and the bytes between them that were not kept
 */

/** Keeps the first `headBytes` and the last `tailBytes` of a stream. */
class EndsKeeper {
  constructor(headBytes, tailBytes) {
    this.headBytes = headBytes;
    this.tailBytes = tailBytes;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.dropped = 0;
  }

  /** @param {Buffer} data */
  push(data) {
    let rest = data;
    if (this.head.length < this.headBytes) {
      const take = rest.subarray(0, this.headBytes - this.head.length);
      this.head = Buffer.concat([this.head, take]);
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    const joined = Buffer.concat([this.tail, rest]);
    const over = Math.max(0, joined.length - this.tailBytes);
    this.dropped += over;
    this.tail = joined.subarray(over);
  }

  /** @returns {Ends} */
  ends() {
    return { head: this.head.toString('utf8'), tail: this.tail.toString('utf8'), dropped: this.dropped };
  }
}

/**
 * @typedef {object} ChildResult
 * @property {number|null} code     exit code, null when killed
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut     the time limit killed it
 * @property {boolean} cut          output past the cap was dropped
 * @property {{ stdout: Ends, stderr: Ends }} [ends] with `keepEnds`: the start and the end of each stream
 * @property {string} [channel]     what the child wrote on fd 3, when a result channel was asked for
 * @property {boolean} [channelCut] the result channel passed its own cap
 */

/**
 * @param {string[]} args arguments to `node` after the confinement flags, never a shell line
 * A result channel (`resultChannel: { maxBytes }`) is a fourth pipe, fd 3, with
 * its own cap: the scoring child writes its one results document there, so
 * whatever the scored code prints on stdout or stderr can neither fill nor
 * cut it (RULE.md 1.3, change 7).
 * @param {{ cwd: string, confine: { read: string[], write: string[] }, timeoutMs?: number, maxOutputBytes?: number,
 * With `keepEnds`, each stream keeps its first and its last quarter of
 * `maxOutputBytes` (`ends`), so a long log never hides what was printed last.
 * @param {{ cwd: string, confine: { read: string[], write: string[] }, timeoutMs?: number, maxOutputBytes?: number,
 *   resultChannel?: { maxBytes: number }, keepEnds?: boolean }} options
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
      stdio: options.resultChannel ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
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
    const keepers = options.keepEnds
      ? { stdout: new EndsKeeper(maxBytes / 4, maxBytes / 4), stderr: new EndsKeeper(maxBytes / 4, maxBytes / 4) }
      : undefined;
    child.stdout.on('data', keepers ? (data) => keepers.stdout.push(data) : keep('stdout'));
    child.stderr.on('data', keepers ? (data) => keepers.stderr.push(data) : keep('stderr'));
    /** @type {Buffer[]} */
    const channel = [];
    let channelBytes = 0;
    let channelCut = false;
    const channelCap = options.resultChannel ? Math.min(options.resultChannel.maxBytes, MAX_OUTPUT_BYTES) : 0;
    if (options.resultChannel) {
      /** @type {import('node:stream').Readable} */ (child.stdio[3]).on('data', (/** @type {Buffer} */ data) => {
        const room = channelCap - channelBytes;
        if (data.length > room) channelCut = true;
        if (room > 0) {
          const part = data.subarray(0, room);
          channel.push(part);
          channelBytes += part.length;
        }
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (/** @type {number|null} */ code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ends = keepers ? { stdout: keepers.stdout.ends(), stderr: keepers.stderr.ends() } : undefined;
      resolve({
        code,
        stdout: ends ? ends.stdout.head + ends.stdout.tail : Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: ends ? ends.stderr.head + ends.stderr.tail : Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut,
        cut: ends ? ends.stdout.dropped + ends.stderr.dropped > 0 : cut,
        ...(ends ? { ends } : {}),
        ...(options.resultChannel ? { channel: Buffer.concat(channel).toString('utf8'), channelCut } : {}),
      });
    };
    child.on('error', (error) => {
      chunks.stderr.push(Buffer.from(String(error)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
