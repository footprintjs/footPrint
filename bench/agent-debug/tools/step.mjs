/**
 * `step` (set-up 3): one step's card, and with a fixture what it read and
 * wrote in that run (tools/record/step.mjs). Never source code.
 */
import { checkInput, tool } from './lib/answer.mjs';
import { checkFixture } from './lib/fixtures.mjs';
import { askProbe } from './lib/probe-client.mjs';

export const LIMIT = 4000;

export const definition = {
  name: 'step',
  description: `Describe one step: its kind, the file its code is in, and its purpose; for a decision, its branches. With a fixture, the program is run on it and the answer adds what the step read and wrote in that run (key names and short value summaries) and, for a decision, each rule it weighed by label and which one matched. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'The step\'s address, as shown by map, for example "grand-total" or "tax/find-rate".' },
      fixture: { type: 'string', description: 'Optional: a fixture name from fixtures/.' },
    },
    required: ['address'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { address: { type: 'string', required: true }, fixture: { type: 'string' } });
  const fixture = input.fixture === undefined ? undefined : checkFixture(context.workdir, input.fixture);
  return askProbe(context.workdir, { op: 'step', address: input.address, ...(fixture ? { fixture } : {}) });
});
