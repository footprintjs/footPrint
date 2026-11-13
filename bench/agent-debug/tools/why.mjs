/**
 * `why` (set-up 3): the chain of steps behind a key's final value in a run
 * of the working copy (tools/record/why.mjs).
 */
import { checkInput, tool } from './lib/answer.mjs';
import { checkFixture } from './lib/fixtures.mjs';
import { askProbe } from './lib/probe-client.mjs';

/** A record tool: only for a program with a chart and a run record (harness/programs.mjs · hasRecord). */
export const NEEDS_RECORD = true;

export const LIMIT = 6000;

export const definition = {
  name: 'why',
  description: `Run the program on a fixture and walk back from the final value of one state key: the step that wrote it last, then the steps whose writes that step read, and so on. Each line names a step run, what it wrote (short value summaries), the keys it read, and for a decision which rule matched. Read from the run's record. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      fixture: { type: 'string', description: 'A fixture name from fixtures/.' },
      key: { type: 'string', description: 'A state key, for example "grandTotal" or "status".' },
    },
    required: ['fixture', 'key'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { fixture: { type: 'string', required: true }, key: { type: 'string', required: true } });
  const fixture = checkFixture(context.workdir, input.fixture);
  return askProbe(context.workdir, { op: 'why', fixture, key: input.key }, context.program);
});
