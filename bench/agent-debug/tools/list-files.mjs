/**
 * `list_files`: every file in the working folder, with its size in lines.
 * Example answer line: `src/steps/grand-total/index.mjs (17 lines)`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listFiles } from '../harness/workdir.mjs';
import { checkInput, tool } from './lib/answer.mjs';

export const LIMIT = 4000;

export const definition = {
  name: 'list_files',
  description: `List every file in the working folder, with its length in lines. Answers are cut at ${LIMIT} characters.`,
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

export const run = tool(LIMIT, (input, context) => {
  checkInput(input, {});
  const files = listFiles(context.workdir);
  return files
    .map((rel) => `${rel} (${readFileSync(join(context.workdir, rel), 'utf8').split('\n').length} lines)`)
    .join('\n');
});
