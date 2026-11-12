/**
 * `run_order`: runs the working copy's program on one fixture and returns
 * its final result FIRST, then what the program printed. This is how an
 * agent adds logs: put a `console.log` in a step, run again.
 *
 * Why the result first and both ends of the logs (RULE.md 1.3, change 7):
 * a developer at a terminal reads the result and the last lines; a long log
 * must not push the result out of the answer.
 */
import { parseResult, runOrderIn } from '../harness/program.mjs';
import { checkInput, tool } from './lib/answer.mjs';
import { headAndTail } from './lib/ends.mjs';
import { checkFixture } from './lib/fixtures.mjs';

export const LIMIT = 6000;
const TIMEOUT_MS = 20000;
/** Characters kept from the start and from the end of each printed stream. */
const STDOUT_ENDS = [1500, 2500];
const STDERR_ENDS = [400, 800];

export const definition = {
  name: 'run_order',
  description: `Run the program in the working folder on one fixture (node src/run-order.mjs fixtures/<fixture>.json). Returns its exit code and its final result as JSON first, then what it printed on stdout (any console.log output) and on stderr; a long printed text keeps its start and its end. Stopped after ${TIMEOUT_MS / 1000} s. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: { fixture: { type: 'string', description: 'A fixture name from fixtures/, for example "small-pickup".' } },
    required: ['fixture'],
    additionalProperties: false,
  },
};

/** Splits stdout into the final result block and what was printed before it. @param {string} stdout */
function splitResult(stdout) {
  const result = parseResult(stdout);
  if (!result) return { result: undefined, printed: stdout };
  const at = stdout.lastIndexOf('\n{\n');
  return { result, printed: at >= 0 ? stdout.slice(0, at) : '' };
}

export const run = tool(LIMIT, async (input, context) => {
  checkInput(input, { fixture: { type: 'string', required: true } });
  const fixture = checkFixture(context.workdir, input.fixture);
  const child = await runOrderIn(context.workdir, fixture, { timeoutMs: TIMEOUT_MS, maxOutputBytes: 400_000, keepEnds: true });
  const out = child.ends?.stdout ?? { head: child.stdout, tail: '', dropped: 0 };
  const err = child.ends?.stderr ?? { head: child.stderr, tail: '', dropped: 0 };
  const { result, printed } = splitResult(out.head + out.tail);
  const parts = [`exit code: ${child.code === null ? 'none (stopped)' : child.code}${child.timedOut ? `, stopped after ${TIMEOUT_MS / 1000} s` : ''}`];
  parts.push(`result:\n${result ? JSON.stringify(result, null, 2) : '(none: the program printed no final result)'}`);
  const printedText = printed.trimEnd();
  if (printedText) parts.push(`printed on stdout:\n${headAndTail(printedText, ...STDOUT_ENDS, out.dropped)}`);
  const errText = (err.head + err.tail).trimEnd();
  if (errText) parts.push(`stderr:\n${headAndTail(errText, ...STDERR_ENDS, err.dropped)}`);
  return parts.join('\n');
});
