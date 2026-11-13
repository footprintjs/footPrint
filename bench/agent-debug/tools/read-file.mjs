/**
 * `read_file`: a file of the working folder with line numbers, whole or a
 * range of lines.
 * Example answer line: `   7| export const purpose = 'Add tax and shipping…';`.
 * Why the description's example is `README.md` (RULE-2.md, "Changed after the
 * fairness readings"): it was `src/chart.mjs`, a file only the flowchart
 * program has and its map in all but name; the example must be a file every
 * set-up's working folder holds.
 */
import { readFileSync, statSync } from 'node:fs';

import { checkInput, tool } from './lib/answer.mjs';
import { FILE_CAP_BYTES } from '../harness/workdir.mjs';
import { resolveInside } from './lib/jail.mjs';

export const LIMIT = 12000;

export const definition = {
  name: 'read_file',
  description: `Read a file in the working folder, with line numbers. Give a path relative to the working folder, such as "README.md"; optionally the first and last line to show (counted from 1). Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working folder.' },
      start_line: { type: 'integer', description: 'First line to show, from 1. Default: 1.' },
      end_line: { type: 'integer', description: 'Last line to show. Default: the last line.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { path: { type: 'string', required: true }, start_line: { type: 'integer' }, end_line: { type: 'integer' } });
  const { abs, rel } = resolveInside(context.workdir, input.path);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`${rel} is a folder; list_files shows the files`);
  if (stat.size > FILE_CAP_BYTES) throw new Error(`${rel} is ${stat.size} bytes, larger than the ${FILE_CAP_BYTES} bytes this tool reads`);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, input.start_line ?? 1);
  const end = Math.min(lines.length, input.end_line ?? lines.length);
  if (start > end) throw new Error(`${rel} has ${lines.length} lines; the range ${start}-${end} is empty`);
  const width = String(end).length;
  const body = lines.slice(start - 1, end).map((text, i) => `${String(start + i).padStart(width)}| ${text}`);
  return [`${rel}, lines ${start}-${end} of ${lines.length}:`, ...body].join('\n');
});
