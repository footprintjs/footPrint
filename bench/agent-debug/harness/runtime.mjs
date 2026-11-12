/**
 * The runtime folder: what a working copy needs to run (the two published
 * libraries, the import hook, the record probe and the scoring child), kept
 * apart from this benchmark's own files.
 *
 * Why apart: every child is confined to READ only its working copy and this
 * folder (harness/child.mjs), so nothing in here may name a fault or an
 * expected result.
 * Why fresh per process: a folder that later runs load must not be one a
 * child could have written, or one some other process left behind. It is
 * made with `mkdtemp` (mode 0700, owner only) inside this process's session
 * folder (harness/temp.mjs), filled here, never reused across processes, and
 * removed with the session; children are never given write access to it.
 * There is no cache.
 * Example: `ensureRuntime()` → `/tmp/agent-debug-session-4242-Ab12Cd/runtime-Xy12Ab`.
 */
import { cpSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTemp } from './temp.mjs';

export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  { from: join(BENCH_DIR, 'harness', 'deps'), to: 'deps' },
  { from: join(BENCH_DIR, 'harness', 'scoring-child'), to: 'scoring' },
  { from: join(BENCH_DIR, 'tools', 'record'), to: 'record' },
  { from: join(BENCH_DIR, 'tools', 'search-child'), to: 'search' },
];
const PACKAGES = ['footprintjs', 'foottrace'];

/** @type {string | undefined} */
let made;

/** Builds this process's runtime folder on first use and returns its path. */
export function ensureRuntime() {
  if (made) return made;
  // A real path (a confined child cannot even stat a symlink such as /tmp
  // above it), private (0700), inside this process's session folder.
  const dir = makeTemp('runtime-');
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  for (const name of PACKAGES) {
    cpSync(join(BENCH_DIR, 'node_modules', name), join(dir, 'node_modules', name), { recursive: true, dereference: true });
  }
  for (const source of SOURCES) cpSync(source.from, join(dir, source.to), { recursive: true });
  made = dir;
  return dir;
}

/**
 * The `--import` arguments every child that loads the program is started
 * with: first the signal guard (deps/guard.mjs), then the import hook.
 */
export function importHookArgs() {
  return guardArgs().concat(['--import', join(ensureRuntime(), 'deps', 'register.mjs')]);
}

/** The signal guard alone, for a confined child that loads no program (the search). */
export function guardArgs() {
  return ['--import', join(ensureRuntime(), 'deps', 'guard.mjs')];
}
