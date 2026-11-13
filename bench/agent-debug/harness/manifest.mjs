/**
 * `program/MANIFEST.json`: the program's files, path → sha256, committed.
 *
 * Why (the reader's N9): a working copy used to be a copy of whatever was in
 * `program/`, untracked files included (an editor backup, a `.DS_Store`). Now
 * it is made from this list only, and the harness refuses to start when a
 * listed file is missing or its content differs, or when anything outside the
 * list is present; a test checks that the list equals `git ls-files program`.
 * Each program of the table (harness/programs.mjs) has its own manifest in
 * its root, listing only `WORKING_KINDS` (src/, fixtures/, README.md,
 * test/visible.test.mjs). Unlisted files refuse the start for the flowchart
 * program; for the twin (`unlistedAllowed`) they are its build material
 * (SPEC.md, its own unit tests, its expected results), never copied.
 * Run: `node harness/manifest.mjs --write [F|P]` after changing a program.
 * Example: `{ "src/chart.mjs": "3f1c…", … }`.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROGRAMS, WORKING_KINDS } from './programs.mjs';
import { Refusal } from './refusal.mjs';

export const PROGRAM_DIR = PROGRAMS.F.dir;
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

/** The entries of a program folder that a manifest may cover: every entry of a working-folder kind. */
function workingEntries(dir) {
  return entriesUnder(dir).filter((r) => WORKING_KINDS.some((kind) => kind.test(r)));
}

/**
 * The list as the program folder holds it now: every entry but the manifest
 * (the flowchart program), or every entry of a working-folder kind (the twin,
 * whose root also holds what is not the program).
 */
export function currentManifest(dir = PROGRAM_DIR, unlistedAllowed = false) {
  /** @type {Record<string, string>} */
  const out = {};
  const entries = unlistedAllowed ? workingEntries(dir) : entriesUnder(dir).filter((r) => r !== MANIFEST_NAME);
  for (const rel of entries) out[rel] = sha256(join(dir, rel));
  return out;
}

/**
 * Checks `program/` against the committed list; throws, naming each
 * difference, when they do not match. Returns the listed paths.
 * @returns {string[]}
 */
export function verifyProgram(dir = PROGRAM_DIR, unlistedAllowed = false) {
  const listed = readManifest(dir);
  const present = entriesUnder(dir).filter((r) => r !== MANIFEST_NAME);
  const problems = [];
  for (const rel of Object.keys(listed)) {
    if (!WORKING_KINDS.some((kind) => kind.test(rel))) problems.push(`not a kind of file a working folder holds: ${rel}`);
  }
  if (!unlistedAllowed) for (const rel of present) if (!(rel in listed)) problems.push(`not in the manifest: ${rel}`);
  for (const [rel, hash] of Object.entries(listed)) {
    if (!present.includes(rel)) problems.push(`missing: ${rel}`);
    else if (sha256(join(dir, rel)) !== hash) problems.push(`changed: ${rel}`);
  }
  if (problems.length > 0) {
    const name = dir === PROGRAM_DIR ? 'program' : dir;
    throw new Refusal(`${name}/ does not match ${name}/${MANIFEST_NAME} (${problems.join('; ')}); the harness does not start.`);
  }
  return Object.keys(listed).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = PROGRAMS[process.argv.includes('P') ? 'P' : 'F'];
  if (process.argv.includes('--write')) {
    writeFileSync(join(program.dir, MANIFEST_NAME), `${JSON.stringify(currentManifest(program.dir, program.unlistedAllowed), null, 2)}\n`);
    console.log(`wrote ${program.dir}/${MANIFEST_NAME}`);
  } else {
    console.log(`${verifyProgram(program.dir, program.unlistedAllowed).length} files match ${program.dir}/${MANIFEST_NAME}`);
  }
}
