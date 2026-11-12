/**
 * `run_tests`: runs the working copy's visible tests and returns which
 * passed, which failed, and the first lines of each failure.
 */
import { runTestFile } from '../harness/program.mjs';
import { checkInput, tool } from './lib/answer.mjs';

export const LIMIT = 4000;
const FAILURE_LINES = 8;

export const definition = {
  name: 'run_tests',
  description: `Run the tests in test/visible.test.mjs on the program in the working folder. Returns the names of the tests that passed and failed, and the first ${FAILURE_LINES} lines of each failure. Answers are cut at ${LIMIT} characters.`,
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

export const run = tool(LIMIT, async (input, context) => {
  checkInput(input, {});
  const result = await runTestFile(context.workdir, 'test/visible.test.mjs');
  const lines = [`${result.passed.length} passed, ${result.failed.length} failed${result.timedOut ? ' (stopped by the time limit)' : ''}`];
  if (result.passed.length) lines.push(`passed: ${result.passed.join('; ')}`);
  for (const name of result.failed) {
    lines.push(`failed: ${name}`);
    for (const detail of (result.details[name] ?? '').split('\n').slice(0, FAILURE_LINES)) lines.push(`  ${detail}`);
  }
  if (result.passed.length === 0 && result.failed.length === 0) {
    lines.push(`no test result was read; stderr:\n${result.stderr.split('\n').slice(0, FAILURE_LINES).join('\n')}`);
  }
  return lines.join('\n');
});
