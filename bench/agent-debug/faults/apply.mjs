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
 * @property {boolean} inDecision the faulty step is a decision of the chart (measured)
 * @property {string} file        path inside the program, under `src/`
 * @property {string} find        the text the edit replaces; occurs exactly once
 * @property {string} replace     the faulty text
 * @property {string} stepAddress the step's id in the run record
 * @property {{ fixture: string, key: string, expected: unknown, actual: unknown }} symptom
 * @property {string[]} hiddenFixtures names of the hidden orders the fault makes give a wrong result
 * @property {{ file: string, find: string, replace: string }} [twin] the same logical fault planted in the
 *   twin (RULE-2.md, "The ten faults of part 1"): one edit under the twin's `src/`, never an edit of the
 *   twin itself (the twin's files stay as its blind writer left them; the fault is data, applied to a
 *   copy). Set-up P refuses a fault without it, at the start of a batch. `test/twin-faults.test.mjs`
 *   proves each pair: the same printed bytes on every hidden order, the same visible tests passing.
 * @property {string} [twinWhy] one line: why the twin's edit is the same business fault as F's
 */

/**
 * The edit of `fault` in one program: its own fields for the flowchart
 * program, its `twin` block for the twin.
 * @param {Fault} fault @param {'F' | 'P'} [program]
 * @returns {{ file: string, find: string, replace: string }}
 */
export function editFor(fault, program = 'F') {
  if (program === 'F') return { file: fault.file, find: fault.find, replace: fault.replace };
  if (!fault.twin) throw new Error(`fault ${fault.id} has no edit planted in the twin (its "twin" block)`);
  return fault.twin;
}

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
 * @param {string} programDir a COPY of a program's root, never the original
 * @param {Fault} fault
 * @param {'F' | 'P'} [program] which program the copy is of
 */
export async function applyFault(programDir, fault, program = 'F') {
  const edit = editFor(fault, program);
  if (!edit.file.startsWith('src/')) throw new Error(`fault ${fault.id}: file must be under src/`);
  const path = join(programDir, edit.file);
  const text = await readFile(path, 'utf8');
  const count = countOccurrences(text, edit.find);
  if (count !== 1) throw new Error(`fault ${fault.id}: find occurs ${count} times in ${edit.file}, expected exactly once`);
  await writeFile(path, text.replace(edit.find, () => edit.replace));
}
