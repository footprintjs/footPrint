/**
 * `run_order`: runs the working copy's program on one fixture and returns
 * what it printed: its final result as JSON, and anything a step logs. This
 * is how an agent adds logs: put a `console.log` in a step, run again.
 */
import { runOrderIn } from '../harness/program.mjs';
import { checkInput, tool } from './lib/answer.mjs';
import { checkFixture } from './lib/fixtures.mjs';

export const LIMIT = 6000;
const TIMEOUT_MS = 20000;

export const definition = {
  name: 'run_order',
  description: `Run the program in the working folder on one fixture (node src/run-order.mjs fixtures/<fixture>.json) and return its exit code, what it printed on stdout (the final result as JSON, and any console.log output) and on stderr. Stopped after ${TIMEOUT_MS / 1000} s. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: { fixture: { type: 'string', description: 'A fixture name from fixtures/, for example "small-pickup".' } },
    required: ['fixture'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, async (input, context) => {
  checkInput(input, { fixture: { type: 'string', required: true } });
  const fixture = checkFixture(context.workdir, input.fixture);
  const child = await runOrderIn(context.workdir, fixture, { timeoutMs: TIMEOUT_MS, maxOutputBytes: LIMIT * 4 });
  const parts = [`exit code: ${child.code === null ? 'none (stopped)' : child.code}${child.timedOut ? `, stopped after ${TIMEOUT_MS / 1000} s` : ''}`];
  parts.push(`stdout:\n${child.stdout.trimEnd() || '(empty)'}`);
  if (child.stderr.trim()) parts.push(`stderr:\n${child.stderr.trimEnd()}`);
  if (child.cut) parts.push('[the program printed more than was kept]');
  return parts.join('\n');
});
