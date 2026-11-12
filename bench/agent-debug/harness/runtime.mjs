/**
 * The runtime folder: what a working copy needs to run, kept apart from this
 * benchmark's own files.
 *
 * Why a copy: every child process of a run is started with
 * `--import <runtime>/deps/register.mjs`, so its command line names that
 * folder. If it were this package's folder, a working copy that prints
 * `process.execArgv` would learn where the hidden tests and the fault list
 * live. The runtime holds only the two published libraries, the import hook
 * and the record probe, nothing that names a fault.
 * Example: `await ensureRuntime()` → `/tmp/agent-debug-runtime-3f2a…`.
 *
 * The folder is keyed by a hash of what it holds, so it is built once and
 * reused by every test process and every run until one of those files changes.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  { from: join(BENCH_DIR, 'harness', 'deps'), to: 'deps' },
  { from: join(BENCH_DIR, 'tools', 'record'), to: 'record' },
];
const PACKAGES = ['footprintjs', 'foottrace'];

/** All files under `dir`, sorted, as paths relative to it. */
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return filesUnder(join(dir, entry.name), rel);
      return entry.isFile() ? [rel] : [];
    });
}

function runtimeKey() {
  const hash = createHash('sha256');
  hash.update(readFileSync(join(BENCH_DIR, 'package-lock.json')));
  for (const source of SOURCES) {
    for (const rel of filesUnder(source.from)) {
      hash.update(`${source.to}/${rel}\0`);
      hash.update(readFileSync(join(source.from, rel)));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

let cached;

/** Builds the runtime folder if it is missing and returns its path. */
export function ensureRuntime() {
  if (cached && existsSync(cached)) return cached;
  const target = join(tmpdir(), `agent-debug-runtime-${runtimeKey()}`);
  if (!existsSync(join(target, 'ready'))) {
    const staging = mkdtempSync(join(tmpdir(), 'agent-debug-runtime-staging-'));
    writeFileSync(join(staging, 'package.json'), '{ "private": true, "type": "module" }\n');
    for (const name of PACKAGES) {
      cpSync(join(BENCH_DIR, 'node_modules', name), join(staging, 'node_modules', name), { recursive: true, dereference: true });
    }
    for (const source of SOURCES) cpSync(source.from, join(staging, source.to), { recursive: true });
    writeFileSync(join(staging, 'ready'), 'ok\n');
    try {
      renameSync(staging, target);
    } catch {
      // Another process built it first; theirs is the same content by key.
      rmSync(staging, { recursive: true, force: true });
    }
  }
  cached = target;
  return target;
}

/** The `--import` argument every child of a run is started with. */
export function importHookArgs() {
  return ['--import', join(ensureRuntime(), 'deps', 'register.mjs')];
}
