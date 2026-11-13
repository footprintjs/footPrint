/**
 * `map` (set-ups 2 and 3): the program's chart, one level deep, built from
 * the REAL chart of the working copy (tools/record/map.mjs).
 */
import { checkInput, tool } from './lib/answer.mjs';
import { askProbe } from './lib/probe-client.mjs';

/** A record tool: only for a program with a chart and a run record (harness/programs.mjs · hasRecord). */
export const NEEDS_RECORD = true;

export const LIMIT = 4000;

export const definition = {
  name: 'map',
  description: `Show the program's flowchart one level deep, read from the chart in src/chart.mjs as it is now. One line per step: "address · kind · purpose". A sub-flowchart is one line; give its address to see its steps. Addresses are the step ids the run record uses. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: { address: { type: 'string', description: 'Optional: a step or sub-flowchart address, for example "tax".' } },
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { address: { type: 'string' } });
  return askProbe(context.workdir, { op: 'map', ...(input.address ? { address: input.address } : {}) }, context.program);
});
