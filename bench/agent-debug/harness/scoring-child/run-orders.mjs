/**
 * The scoring child: runs the scored copy's program on each hidden order and
 * writes ONE JSON document of results to fd 3, the result channel. It
 * computes; it never judges. The expected results never enter this process:
 * they stay in the benchmark folder and the parent compares (harness/score.mjs).
 *
 * Why fd 3, and why silence first (RULE.md 1.3, change 7): logs the agent
 * left in a correct fix must not cost it the score. Before the copy is
 * imported, `console.*` and `process.stdout/stderr.write` are made silent, so
 * nothing the copy prints reaches any channel; the results go to fd 3, a pipe
 * with its own cap that the copy has no reason to touch. If the copy writes to
 * fd 3 anyway, the parent finds more than one document and scores unsolved.
 *
 * Usage (confined, read-only): `node run-orders.mjs <scored copy> <orders file> [entry] [program]`;
 * `entry` is the program's entry module (harness/programs.mjs), `src/order-desk.mjs` by default, and
 * `program` (`F` or `P`, `F` by default) picks how that module is called (result-of.mjs · RESULT_OF):
 * the two programs do not share an entry point and the twin is never edited to make them.
 */
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RESULT_OF } from './result-of.mjs';

const RESULT_CHANNEL = 3;
const [copy, ordersFile, entry = 'src/order-desk.mjs', program = 'F'] = process.argv.slice(2);
const resultOf = RESULT_OF[/** @type {'F' | 'P'} */ (program)];
if (!resultOf) throw new Error(`no program ${program}; the programs are F and P`);
const orders = JSON.parse(readFileSync(ordersFile, 'utf8'));

const quiet = () => {};
for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd', 'count', 'time', 'timeEnd', 'timeLog', 'assert']) {
  /** @type {any} */ (console)[name] = quiet;
}
process.stdout.write = () => true;
process.stderr.write = () => true;

const entryModule = await import(pathToFileURL(join(copy, entry)).href);
/** @type {Record<string, unknown>} */
const results = {};
for (const [name, order] of Object.entries(orders)) {
  try {
    results[name] = await resultOf(entryModule, order);
  } catch (error) {
    results[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}
writeSync(RESULT_CHANNEL, `${JSON.stringify({ results })}\n`);
