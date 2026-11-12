/**
 * `edit_file`: replaces one exact piece of text in a file under `src/`.
 *
 * Why exactly once: an edit that could land in two places is ambiguous; the
 * agent must quote enough of the line to make it unique.
 * Example: `{ path: 'src/steps/x/index.mjs', find: 'a + b', replace: 'a - b' }` → `edited …`.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { countOccurrences } from '../faults/apply.mjs';
import { checkInput, tool } from './lib/answer.mjs';
import { FILE_CAP_BYTES } from '../harness/workdir.mjs';
import { resolveInside } from './lib/jail.mjs';

export const LIMIT = 1000;
const MAX_REPLACE = 20000;

export const definition = {
  name: 'edit_file',
  description: `Edit a file under src/ by replacing one exact piece of text. "find" must occur exactly once in the file (include enough of the surrounding line to make it unique); it is replaced by "replace". Only existing files under src/ can be edited. Answers are cut at ${LIMIT} characters.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working folder, starting with src/.' },
      find: { type: 'string', description: 'The exact text to replace; must occur exactly once.' },
      replace: { type: 'string', description: 'The new text.' },
    },
    required: ['path', 'find', 'replace'],
    additionalProperties: false,
  },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, { path: { type: 'string', required: true }, find: { type: 'string', required: true }, replace: { type: 'string', required: true } });
  const { abs, rel } = resolveInside(context.workdir, input.path);
  if (!rel.startsWith('src/')) throw new Error('only files under src/ can be edited');
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`${rel} is not a file`);
  if (stat.size > FILE_CAP_BYTES) throw new Error(`${rel} is ${stat.size} bytes, larger than the ${FILE_CAP_BYTES} bytes this tool edits`);
  if (input.find.length === 0) throw new Error('"find" is empty');
  if (input.replace.length > MAX_REPLACE) throw new Error(`"replace" is longer than ${MAX_REPLACE} characters`);
  const text = readFileSync(abs, 'utf8');
  const count = countOccurrences(text, input.find);
  if (count !== 1) throw new Error(`"find" occurs ${count} times in ${rel}; it must occur exactly once`);
  writeFileSync(abs, text.replace(input.find, () => input.replace));
  const removed = input.find.split('\n').length;
  const added = input.replace.split('\n').length;
  return `edited ${rel}: replaced ${removed} line(s) with ${added} line(s)`;
});
