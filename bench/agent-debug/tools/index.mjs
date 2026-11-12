/**
 * The three set-ups of RULE.md and the tools each one gets. One owner for
 * that list, so the harness, the system prompt and the tests cannot disagree.
 *
 * | Set-up | Tools |
 * |---|---|
 * | 1. Code and logs | list_files, read_file, search, run_order, run_tests, edit_file, done |
 * | 2. Plus the map | set-up 1 and map |
 * | 3. Plus the record | set-up 2 and step, why, story |
 */
import * as done from './done.mjs';
import * as editFile from './edit-file.mjs';
import * as listFiles from './list-files.mjs';
import * as map from './map.mjs';
import * as readFile from './read-file.mjs';
import * as runOrder from './run-order.mjs';
import * as runTests from './run-tests.mjs';
import * as search from './search.mjs';
import * as step from './step.mjs';
import * as story from './story.mjs';
import * as why from './why.mjs';

/** @typedef {{ definition: { name: string, description: string, input_schema: object }, run: (input: any, context: { workdir: string }) => Promise<import('./lib/answer.mjs').ToolAnswer>, LIMIT: number }} Tool */

const CODE_AND_LOGS = [listFiles, readFile, search, runOrder, runTests, editFile, done];

/** @type {Record<1|2|3, Tool[]>} */
export const SETUPS = {
  1: CODE_AND_LOGS,
  2: [...CODE_AND_LOGS, map],
  3: [...CODE_AND_LOGS, map, step, why, story],
};

/** @param {number} setup @returns {Tool[]} */
export function toolsFor(setup) {
  const tools = SETUPS[/** @type {1|2|3} */ (setup)];
  if (!tools) throw new Error(`no set-up ${setup}; use 1, 2 or 3`);
  return tools;
}

/**
 * Runs one tool call; an unknown tool name is an error answer, never a throw.
 * @param {Tool[]} tools @param {string} name @param {unknown} input @param {{ workdir: string }} context
 */
export async function callTool(tools, name, input, context) {
  const found = tools.find((t) => t.definition.name === name);
  if (!found) return { content: `error: no tool named ${name} in this set-up`, is_error: /** @type {const} */ (true) };
  try {
    return await found.run(input, context);
  } catch (error) {
    return { content: `error: ${error instanceof Error ? error.message : String(error)}`, is_error: /** @type {const} */ (true) };
  }
}
