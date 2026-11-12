/**
 * Applies one planted fault to a copy of the program.
 *
 * Why it refuses so much: a fault is one small edit, and the benchmark is only
 * honest if that edit lands exactly where its file says. A `find` that occurs
 * twice, or not at all, means the program and the fault list disagree, and
 * the run would measure something else. Example:
 * `applyFault('/tmp/x', fault)` edits `/tmp/x/src/steps/grand-total/index.mjs`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAULTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} Fault
 * @property {string} id
 * @property {'data-flow'|'inside-step'} class
 * @property {string} kind
 * @property {number} distance
 * @property {string} file        path inside the program, under `src/`
 * @property {string} find        the text the edit replaces; occurs exactly once
 * @property {string} replace     the faulty text
 * @property {string} stepAddress the step's id in the run record
 * @property {{ fixture: string, key: string, expected: unknown, actual: unknown }} symptom
 * @property {string[]} hiddenFixtures names of the hidden orders the fault makes give a wrong result
 */

/** Counts the non-overlapping occurrences of `needle` in `text`. */
export function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Loads every fault file, sorted by id. @returns {Fault[]} */
export function loadFaults() {
  return readdirSync(FAULTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(FAULTS_DIR, name), 'utf8')))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Loads one fault by id. @returns {Fault} */
export function loadFault(id) {
  const fault = loadFaults().find((f) => f.id === id);
  if (!fault) throw new Error(`no fault with id ${id}`);
  return fault;
}

/**
 * Applies `fault` to the program copy at `programDir`.
 * @param {string} programDir a COPY of `program/`, never the original
 * @param {Fault} fault
 */
export async function applyFault(programDir, fault) {
  if (!fault.file.startsWith('src/')) throw new Error(`fault ${fault.id}: file must be under src/`);
  const path = join(programDir, fault.file);
  const text = await readFile(path, 'utf8');
  const count = countOccurrences(text, fault.find);
  if (count !== 1) throw new Error(`fault ${fault.id}: find occurs ${count} times in ${fault.file}, expected exactly once`);
  await writeFile(path, text.replace(fault.find, () => fault.replace));
}
