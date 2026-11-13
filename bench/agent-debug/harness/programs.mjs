/**
 * Which program each set-up runs: the ONE table (RULE-2.md, "The four set-ups").
 *
 * | Set-up | Program | Root |
 * |---|---|---|
 * | P | the ordinary twin | `twin/` |
 * | 1, 2, 3 | the flowchart program | `program/` |
 *
 * Why one table: the working-folder copy (workdir.mjs), `run_order` and
 * `run_tests` (program.mjs), the manifest check (manifest.mjs), the scoring
 * child (score.mjs) and the tool sets (tools/index.mjs) all ask it, so adding
 * the twin is data here, not an edit in five places.
 *
 * - `runScript`, `testFile`: the paths the tool descriptions name
 *   (`node src/run-order.mjs fixtures/<f>.json`, `test/visible.test.mjs`).
 *   The tools' words are part 1's and the same in every set-up, so both
 *   programs MUST use these paths; a test pins that.
 * - `entry`: the module the scoring child imports, and `resultOf`, how
 *   that module gives the printed result of one order (the ONE owner is
 *   scoring-child/result-of.mjs · RESULT_OF, which the confined scoring
 *   child imports too). The flowchart program exports `async runOrder(order)`
 *   giving the nine keys; the twin exports `runOrder({ order })` giving every
 *   figure and `toResult(figures)` giving the nine keys, both synchronous.
 *   Why an adapter and not the command line: the scoring child is confined
 *   and may start no process, and its result channel must not carry what
 *   the copy prints; calling in process keeps the child as it was. Why not
 *   edit the twin: it was written blind, and an edit by someone who has seen
 *   the flowchart program would end that.
 * - `hasRecord`: whether the record tools (`map`, `step`, `why`, `story`) can
 *   exist for it. Only the flowchart program has a chart and a run record;
 *   a set-up whose program has none can never be handed those tools.
 * - `unlistedAllowed`: what a file in the root that its manifest does not
 *   list means. For the flowchart program it is an error (part 1's rule: a
 *   stray editor backup stops the harness). For the twin it is expected:
 *   `twin/SPEC.md` (the prose it was written from), its own unit tests and
 *   the expected results it was built against live there, OUTSIDE its
 *   manifest (RULE-2.md, "Both working folders hold the same kinds of
 *   thing"). A working folder is copied from the manifest's list only, so
 *   none of them is ever copied or reachable by a tool.
 * Both manifests may list only the same kinds of thing (`WORKING_KINDS`):
 * `src/`, `fixtures/`, `README.md` and `test/visible.test.mjs`.
 * Example: `programFor(1).dir` → `<bench>/program`; `programFor('P')` throws
 * "the twin is not built yet" until `twin/src` exists.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Refusal } from './refusal.mjs';
import { BENCH_DIR } from './runtime.mjs';
import { RESULT_OF } from './scoring-child/result-of.mjs';

/**
 * @typedef {object} Program
 * @property {'F' | 'P'} id
 * @property {string} name
 * @property {string} dir        the program root
 * @property {string} runScript  relative to the root
 * @property {string} testFile   relative to the root
 * @property {string} entry      relative to the root
 * @property {import('./scoring-child/result-of.mjs').ResultOf} resultOf how `entry` gives one order's printed result
 * @property {boolean} hasRecord
 * @property {boolean} unlistedAllowed whether files the manifest does not list may sit in the root (never copied)
 */

/** What a working folder may hold, in either program (RULE-2.md). */
export const WORKING_KINDS = Object.freeze([/^src\//, /^fixtures\/[a-z0-9-]+\.json$/, /^README\.md$/, /^test\/visible\.test\.mjs$/]);

/** @type {Readonly<Record<'F' | 'P', Readonly<Program>>>} */
export const PROGRAMS = Object.freeze({
  F: Object.freeze({
    id: 'F', name: 'the flowchart program', dir: join(BENCH_DIR, 'program'),
    runScript: 'src/run-order.mjs', testFile: 'test/visible.test.mjs', entry: 'src/order-desk.mjs', resultOf: RESULT_OF.F,
    hasRecord: true, unlistedAllowed: false,
  }),
  P: Object.freeze({
    id: 'P', name: 'the ordinary twin', dir: join(BENCH_DIR, 'twin'),
    runScript: 'src/run-order.mjs', testFile: 'test/visible.test.mjs', entry: 'src/order-desk.mjs', resultOf: RESULT_OF.P,
    hasRecord: false, unlistedAllowed: true,
  }),
});

/** Set-up → program id. Set-ups are the numbers 1, 2, 3 and the letter P. */
export const SETUP_PROGRAM = Object.freeze({ P: 'P', 1: 'F', 2: 'F', 3: 'F' });

/** Every set-up id, in the order reports show them. */
export const SETUP_IDS = Object.freeze(['P', 1, 2, 3]);

/** Reads a set-up id given as text or number: `'P'`, `'1'`, `1` → `'P'`, `1`, `1`. */
export function parseSetup(value) {
  if (value === 'P' || value === 'p') return 'P';
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  throw new Refusal(`there is no set-up ${JSON.stringify(value)}; the set-ups are P, 1, 2 and 3.`);
}

/** The program id of a set-up, without asking whether that program exists. @returns {'F' | 'P'} */
export function programIdOf(setup) {
  const id = SETUP_PROGRAM[/** @type {'P'|1|2|3} */ (setup)];
  if (!id) throw new Refusal(`there is no set-up ${JSON.stringify(setup)}; the set-ups are P, 1, 2 and 3.`);
  return id;
}

/** The sentence every refusal of set-up P gives while the twin is missing. */
export const TWIN_MISSING = 'the twin is not built yet: set-up P runs the program in twin/, and twin/src does not exist';

/**
 * The program a set-up runs, refused by name when it is not there.
 * @param {'P'|1|2|3} setup
 * @returns {Readonly<Program>}
 */
export function programFor(setup) {
  return programFrom(PROGRAMS, setup);
}

/**
 * `programFor` over a given table: the refusal itself, so that a test can
 * show it still fires for a twin whose `src/` is missing, now that the real
 * twin is in place.
 * @param {Readonly<Record<'F' | 'P', Readonly<Program>>>} table
 * @param {'P'|1|2|3} setup
 * @returns {Readonly<Program>}
 */
export function programFrom(table, setup) {
  const program = table[programIdOf(setup)];
  if (!existsSync(join(program.dir, 'src'))) {
    throw new Refusal(program.id === 'P' ? `${TWIN_MISSING}.` : `${program.dir}/src does not exist.`);
  }
  return program;
}
