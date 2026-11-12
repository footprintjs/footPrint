/**
 * A fresh working folder for one run: a copy of `program/` with one fault
 * applied, and nothing else.
 *
 * Why nothing else: the agent's tools are jailed to this folder, so what is in
 * it is all the agent can ever read. The hidden tests, the fault list, the
 * rule and the harness stay in the benchmark's folder; the libraries stay in
 * the runtime folder (harness/runtime.mjs).
 * Example: `const w = await createWorkdir(fault)` → `w.dir = /tmp/agent-debug-run-AbC123`.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyFault } from '../faults/apply.mjs';
import { BENCH_DIR } from './runtime.mjs';

export const PROGRAM_DIR = join(BENCH_DIR, 'program');

/** Every regular file under `dir`, as sorted relative paths with `/`. */
export function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listFiles(join(dir, entry.name), rel);
      return entry.isFile() ? [rel] : [];
    });
}

/** A map of relative path → sha256 of every file under `dir`. */
export function manifestOf(dir) {
  /** @type {Record<string, string>} */
  const manifest = {};
  for (const rel of listFiles(dir)) {
    manifest[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
  }
  return manifest;
}

/**
 * Copies the program into a new temporary folder and applies `fault` to it
 * (none for the unmodified program).
 * @param {import('../faults/apply.mjs').Fault | null} fault
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<{ dir: string, manifest: Record<string, string> }>}
 */
export async function createWorkdir(fault, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), options.prefix ?? 'agent-debug-run-')));
  cpSync(PROGRAM_DIR, dir, { recursive: true });
  if (fault) await applyFault(dir, fault);
  return { dir, manifest: manifestOf(dir) };
}

/** Removes a folder made by `createWorkdir`; refuses anything outside the temp folder. */
export function removeWorkdir(dir) {
  const root = realpathSync(tmpdir());
  if (!realpathSync(dir).startsWith(`${root}/agent-debug-`)) throw new Error(`refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
