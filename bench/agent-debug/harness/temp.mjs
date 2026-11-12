/**
 * Every temporary folder of one harness process lives inside ONE session
 * folder, `<tmp>/agent-debug-session-<pid>-XXXXXX` (mode 0700), next to an
 * `owner.json` that names the process. Working copies, scoring copies, staging
 * copies and the runtime folder are made inside it with `mkdtemp`.
 *
 * Why: a run must remove its folders when it ends or is stopped.
 * - Normal end, an error, Ctrl-C (SIGINT), SIGTERM or SIGHUP: the session
 *   folder is removed before the process exits.
 * - SIGKILL (or a crash of the machine) cannot be caught: the session folder
 *   stays. The NEXT harness process that starts sweeps every session folder
 *   whose `owner.json` names a process that no longer exists (`sweepStale`).
 *   A folder of a live process, or a folder without `owner.json`, is never
 *   touched: the sweep cannot remove another session's work.
 * A confined child is never given read access to the session folder itself,
 * only to its own copy inside it, so it never sees `owner.json`.
 * Example: `makeTemp('run-')` → `/tmp/agent-debug-session-4242-Ab12Cd/run-Xy34Ef`.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

export const SESSION_PREFIX = 'agent-debug-session-';

/** @type {string | undefined} */
let session;

/**
 * Whether a process with this id is alive. Only ESRCH (no such process)
 * counts as dead; EPERM (not permitted, for example a process the sandbox
 * hides or refuses to signal) counts as ALIVE.
 */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error).code === 'EPERM';
  }
}

/**
 * Removes the session folders of processes that no longer exist.
 * @returns {string[]} the folders removed
 */
export function sweepStale() {
  const root = realpathSync(tmpdir());
  const removed = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(SESSION_PREFIX)) continue;
    const dir = join(root, name);
    const ownerFile = join(dir, 'owner.json');
    if (!existsSync(ownerFile)) continue;
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(owner.pid) || owner.pid === process.pid || alive(owner.pid)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

function removeSession() {
  if (session) rmSync(session, { recursive: true, force: true });
  session = undefined;
}

/** This process's session folder, made (and stale ones swept) on first use. */
export function sessionDir() {
  if (session && existsSync(session)) return session;
  sweepStale();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${SESSION_PREFIX}${process.pid}-`)));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`);
  session = dir;
  process.once('exit', removeSession);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.once(signal, () => {
      removeSession();
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]);
    });
  }
  return dir;
}

/** A new private folder inside the session folder. @param {string} prefix */
export function makeTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(sessionDir(), prefix)));
  chmodSync(dir, 0o700);
  return dir;
}

/** Removes a folder made by `makeTemp`; refuses anything else. @param {string} dir */
export function removeTemp(dir) {
  const real = realpathSync(dir);
  if (!session || !real.startsWith(`${session}${sep}`)) throw new Error(`refusing to remove ${dir}: not a folder of this session`);
  rmSync(real, { recursive: true, force: true });
}
