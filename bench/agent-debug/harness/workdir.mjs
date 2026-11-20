/**
 * A fresh working folder for one run: a copy of one program's root (the
 * flowchart program or the twin, harness/programs.mjs) with at most one
 * fault applied, and nothing else.
 *
 * Why nothing else: the agent's tools are jailed to this folder, so what is in
 * it is all the agent can ever read. The hidden data, the fault list, the
 * rule and the harness stay in the benchmark's folder; the libraries stay in
 * the runtime folder (harness/runtime.mjs).
 *
 * Why a staging copy (RULE.md 1.3, change 1): a fault applied in place makes
 * the faulty file the newest file, and an agent that lists files by time finds
 * it without debugging. So the fault is applied in a STAGING copy, and the
 * staging copy is then placed: every file is copied in one fixed order (sorted
 * paths) and given one fixed time. The faulty copy and a clean copy then order
 * their files the same way by mtime, ctime and birthtime; only content differs.
 * Example: `const w = await createWorkdir(fault)` →
 * `w.dir = /tmp/agent-debug-session-4242-Ab12Cd/run-Xy34Ef`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { applyFault } from '../faults/apply.mjs';
import { PROGRAM_DIR, verifyProgram } from './manifest.mjs';
import { PROGRAMS } from './programs.mjs';
import { makeTemp, removeTemp } from './temp.mjs';

export { PROGRAM_DIR };

/** The one time every placed file and folder carries. */
export const PLACED_TIME = new Date('2026-11-01T00:00:00.000Z');

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

/**
 * The largest file the harness and the tools ever read, in bytes. The
 * program's files are a few kilobytes; a file past this is the agent's own
 * doing (RULE.md 1.4: a 3 GB sparse file once ended the harness at scoring),
 * so it is never read: the manifest records its size, the tools refuse it,
 * and scoring a copy that holds one is an unsolved run.
 */
export const FILE_CAP_BYTES = 1_000_000;

/** Files under `dir` larger than `FILE_CAP_BYTES`, as relative paths. */
export function oversizeFiles(dir) {
  return listFiles(dir).filter((rel) => statSync(join(dir, rel)).size > FILE_CAP_BYTES);
}

/**
 * A map of relative path → sha256 of every file under `dir`; a file past
 * `FILE_CAP_BYTES` is recorded as `oversize:<bytes>` and never read.
 */
export function manifestOf(dir) {
  /** @type {Record<string, string>} */
  const manifest = {};
  for (const rel of listFiles(dir)) {
    const size = statSync(join(dir, rel)).size;
    manifest[rel] = size > FILE_CAP_BYTES ? `oversize:${size}` : createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
  }
  return manifest;
}

/**
 * Copies every file of `from` into the empty folder `to`, in sorted order,
 * then gives every file and folder the same fixed time, in the same order.
 * Two placements of trees with the same paths are indistinguishable by time.
 * @param {string} from @param {string} to
 */
export function placeCopy(from, to) {
  const files = listFiles(from);
  for (const rel of files) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(join(from, rel), join(to, rel));
  }
  const folders = [...new Set(files.flatMap((rel) => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();
  for (const rel of files) utimesSync(join(to, rel), PLACED_TIME, PLACED_TIME);
  for (const rel of folders.reverse()) utimesSync(join(to, rel), PLACED_TIME, PLACED_TIME);
  utimesSync(to, PLACED_TIME, PLACED_TIME);
}

/**
 * Builds a staging copy with `prepare`, then places it into a new folder.
 * @param {string} prefix the new folder's name prefix
 * @param {(staging: string) => Promise<void> | void} prepare
 */
export async function placedFolder(prefix, prepare) {
  const staging = makeTemp('staging-');
  try {
    await prepare(staging);
    const dir = makeTemp(prefix);
    placeCopy(staging, dir);
    return dir;
  } finally {
    removeTemp(staging);
  }
}

/**
 * Copies a program's listed files (its MANIFEST.json, checked first) into a
 * staging folder: the listed files only, so nothing else in the program's
 * root (the twin's SPEC.md, its own tests and expected results) is copied.
 * @param {string} staging
 * @param {import('./programs.mjs').Program} [program]
 */
export function stageProgram(staging, program = PROGRAMS.F) {
  for (const rel of verifyProgram(program.dir, program.unlistedAllowed)) {
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    copyFileSync(join(program.dir, rel), join(staging, rel));
  }
}

/**
 * Copies a program into a new folder with `fault` applied (none for the
 * unmodified program, as a question's working folder is).
 * @param {import('../faults/apply.mjs').Fault | null} fault
 * @param {{ prefix?: string, program?: import('./programs.mjs').Program }} [options]
 * @returns {Promise<{ dir: string, manifest: Record<string, string> }>}
 */
export async function createWorkdir(fault, options = {}) {
  const program = options.program ?? PROGRAMS.F;
  const dir = await placedFolder(options.prefix ?? 'run-', async (staging) => {
    stageProgram(staging, program);
    if (fault) await applyFault(staging, fault, program.id);
  });
  return { dir, manifest: manifestOf(dir) };
}

/** Removes a folder made by `createWorkdir`; refuses anything outside this process's session. */
export function removeWorkdir(dir) {
  removeTemp(dir);
}
