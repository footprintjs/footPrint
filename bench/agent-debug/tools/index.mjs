/**
 * The set-ups of RULE.md and RULE-2.md and the tools each one gets. One owner
 * for that list, so the harness, the system prompt and the tests cannot disagree.
 *
 * | Set-up | Program | Tools |
 * |---|---|---|
 * | P. Ordinary code | the twin | list_files, read_file, search, run_order, run_tests, edit_file, done |
 * | 1. Code and logs | the flowchart program | the same |
 * | 2. Plus the map | the flowchart program | set-up 1 and map |
 * | 3. Plus the record | the flowchart program | set-up 2 and step, why, story |
 *
 * For a question task, `answer` (tools/answer.mjs, with the question's
 * answer schema) takes the place of `done`, in the same position.
 * Why the check at load time: the record tools exist only for a program with
 * a chart and a run record (harness/programs.mjs · hasRecord). A set-up table
 * that hands one to set-up P does not load.
 */
import { programIdOf, PROGRAMS } from '../harness/programs.mjs';
import { answerTool } from './answer.mjs';
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

/**
 * @typedef {{ definition: { name: string, description: string, input_schema: object },
 *   run: (input: any, context: ToolContext) => Promise<import('./lib/answer.mjs').ToolAnswer>, LIMIT: number, NEEDS_RECORD?: boolean }} Tool
 * @typedef {{ workdir: string, program?: import('../harness/programs.mjs').Program }} ToolContext
 */

const CODE_AND_LOGS = [listFiles, readFile, search, runOrder, runTests, editFile, done];

/** @type {Readonly<Record<'P'|1|2|3, Tool[]>>} */
export const SETUPS = Object.freeze({
  P: CODE_AND_LOGS,
  1: CODE_AND_LOGS,
  2: [...CODE_AND_LOGS, map],
  3: [...CODE_AND_LOGS, map, step, why, story],
});

for (const [setup, tools] of Object.entries(SETUPS)) {
  const program = PROGRAMS[programIdOf(setup === 'P' ? 'P' : Number(setup))];
  const record = tools.filter((t) => t.NEEDS_RECORD).map((t) => t.definition.name);
  if (!program.hasRecord && record.length > 0) {
    throw new Error(`set-up ${setup} runs ${program.name}, which has no record, and may not get ${record.join(', ')}`);
  }
}

/**
 * The tools of a set-up; with an answer schema, the tools of a question
 * task (`answer` in place of `done`).
 * @param {'P'|1|2|3} setup @param {object} [answerSchema] harness/shapes.mjs · schemaOf of the question's shape
 * @returns {Tool[]}
 */
export function toolsFor(setup, answerSchema) {
  const tools = SETUPS[/** @type {'P'|1|2|3} */ (setup)];
  if (!tools) throw new Error(`no set-up ${setup}; use P, 1, 2 or 3`);
  if (!answerSchema) return tools;
  const answer = answerTool(answerSchema);
  return tools.map((t) => (t === done ? answer : t));
}

/**
 * Runs one tool call; an unknown tool name is an error answer, never a throw.
 * @param {Tool[]} tools @param {string} name @param {unknown} input @param {ToolContext} context
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
