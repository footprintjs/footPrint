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
 * made with `mkdtemp` (mode 0700, owner only), filled here, never reused
 * across processes, and removed when the process exits; children are never
 * given write access to it. There is no cache.
 * Example: `ensureRuntime()` → `/tmp/agent-debug-runtime-Xy12Ab`.
 */
import { chmodSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // A real path: a confined child cannot even stat a symlink (such as /tmp) above it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-debug-runtime-')));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  for (const name of PACKAGES) {
    cpSync(join(BENCH_DIR, 'node_modules', name), join(dir, 'node_modules', name), { recursive: true, dereference: true });
  }
  for (const source of SOURCES) cpSync(source.from, join(dir, source.to), { recursive: true });
  made = dir;
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The `--import` argument every child that loads the program is started with. */
export function importHookArgs() {
  return ['--import', join(ensureRuntime(), 'deps', 'register.mjs')];
}
