/**
 * `program/MANIFEST.json`: the program's files, path → sha256, committed.
 *
 * Why (the reader's N9): a working copy used to be a copy of whatever was in
 * `program/`, untracked files included (an editor backup, a `.DS_Store`). Now
 * it is made from this list only, and the harness refuses to start when a
 * listed file is missing or its content differs, or when anything outside the
 * list is present; a test checks that the list equals `git ls-files program`.
 * Run: `node harness/manifest.mjs --write` after changing the program.
 * Example: `{ "src/chart.mjs": "3f1c…", … }`.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BENCH_DIR } from './runtime.mjs';

export const PROGRAM_DIR = join(BENCH_DIR, 'program');
export const MANIFEST_NAME = 'MANIFEST.json';

/** Every entry under `dir` that is not a folder (files, links, anything), as sorted relative paths. */
function entriesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? entriesUnder(join(dir, entry.name), rel) : [rel];
    });
}

const sha256 = (/** @type {string} */ file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The committed list. @returns {Record<string, string>} */
export function readManifest(dir = PROGRAM_DIR) {
  return JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'));
}

/** The list as the program folder holds it now (every entry but the manifest). */
export function currentManifest(dir = PROGRAM_DIR) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rel of entriesUnder(dir).filter((r) => r !== MANIFEST_NAME)) out[rel] = sha256(join(dir, rel));
  return out;
}

/**
 * Checks `program/` against the committed list; throws, naming each
 * difference, when they do not match. Returns the listed paths.
 * @returns {string[]}
 */
export function verifyProgram(dir = PROGRAM_DIR) {
  const listed = readManifest(dir);
  const present = entriesUnder(dir).filter((r) => r !== MANIFEST_NAME);
  const problems = [];
  for (const rel of present) if (!(rel in listed)) problems.push(`not in the manifest: ${rel}`);
  for (const [rel, hash] of Object.entries(listed)) {
    if (!present.includes(rel)) problems.push(`missing: ${rel}`);
    else if (sha256(join(dir, rel)) !== hash) problems.push(`changed: ${rel}`);
  }
  if (problems.length > 0) {
    throw new Error(`program/ does not match program/${MANIFEST_NAME} (${problems.join('; ')}); the harness does not start`);
  }
  return Object.keys(listed).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write')) {
    writeFileSync(join(PROGRAM_DIR, MANIFEST_NAME), `${JSON.stringify(currentManifest(), null, 2)}\n`);
    console.log(`wrote program/${MANIFEST_NAME}`);
  } else {
    console.log(`${verifyProgram().length} files match program/${MANIFEST_NAME}`);
  }
}
