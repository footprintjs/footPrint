/**
 * `search`: every line of every file in the working folder that matches a
 * regular expression.
 * Example answer line: `src/steps/net-amount/index.mjs:14: scope.netAmount = roundCents(…);`.
 */
import { join } from 'node:path';

import { runNode } from '../harness/child.mjs';
import { ensureRuntime } from '../harness/runtime.mjs';
import { checkInput, tool } from './lib/answer.mjs';

export const LIMIT = 4000;

export const definition = {
  name: 'search',
  description: `Search every file in the working folder for lines matching a JavaScript regular expression (case-sensitive). Returns "path:line: text" for each match. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'A JavaScript regular expression, for example "grandTotal" or "tax|shipping".' } },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, async (input, context) => {
  checkInput(input, { pattern: { type: 'string', required: true } });
  if (input.pattern.length === 0 || input.pattern.length > 500) throw new Error('the pattern must be 1 to 500 characters');
  const worker = join(ensureRuntime(), 'search', 'search.mjs');
  const child = await runNode([worker, context.workdir, input.pattern], {
    cwd: context.workdir,
    confine: { read: [context.workdir, worker], write: [] },
    timeoutMs: 5000,
  });
  if (child.timedOut) throw new Error('the search took longer than 5 s and was stopped; try a simpler pattern');
  const out = JSON.parse(child.stdout);
  if (out.error) throw new Error(out.error);
  if (out.total === 0) return `no line matches ${input.pattern}`;
  const lines = out.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
  if (out.total > out.matches.length) lines.push(`(${out.total - out.matches.length} more matches not shown)`);
  return [`${out.total} matching line(s):`, ...lines].join('\n');
});
