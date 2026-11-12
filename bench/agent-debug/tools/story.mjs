/**
 * `story` (set-up 3): the run told step by step, from the library's own
 * narrative (tools/record/story.mjs).
 */
import { checkInput, tool } from './lib/answer.mjs';
import { checkFixture } from './lib/fixtures.mjs';
import { askProbe } from './lib/probe-client.mjs';

export const LIMIT = 8000;

export const definition = {
  name: 'story',
  description: `Run the program on a fixture and tell the run step by step: each step in order, the keys it read and wrote with their values, and each decision with the rule that matched. Optionally only one step or one sub-flowchart, by address. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      fixture: { type: 'string', description: 'A fixture name from fixtures/.' },
      address: { type: 'string', description: 'Optional: a step or sub-flowchart address, for example "tax".' },
    },
    required: ['fixture'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { fixture: { type: 'string', required: true }, address: { type: 'string' } });
  const fixture = checkFixture(context.workdir, input.fixture);
  return askProbe(context.workdir, { op: 'story', fixture, ...(input.address ? { address: input.address } : {}) });
});
