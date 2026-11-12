/**
 * `done`: the agent says it has finished, in one sentence naming the step it
 * changed. The run ends after this call.
 */
import { checkInput, tool } from './lib/answer.mjs';

export const LIMIT = 200;

export const definition = {
  name: 'done',
  description: `Call this once when you have finished, with one sentence naming the step you changed. The run ends after this call. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: { summary: { type: 'string', description: 'One sentence naming the step you changed.' } },
    required: ['summary'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input) => {
  checkInput(input, { summary: { type: 'string', required: true } });
  return 'Recorded. The run ends here.';
});
