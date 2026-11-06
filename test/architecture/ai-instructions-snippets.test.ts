/**
 * The canonical snippets in `AGENTS.md` run, and print what they say they print.
 * Each is a real file whose `// Output:` block is compared with the run, through the built package.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const DIR = join(REPO, 'ai-instructions/source/snippets');
const files = readdirSync(DIR).filter((file) => file.endsWith('.mts'));

/** The lines under `// Output:`, without their comment marks. */
function expectedOutput(source: string): string {
  const [, block] = source.split('// Output:\n');
  if (block === undefined) throw new Error('A snippet must end with an // Output: block.');
  return block.replace(/^\/\/ ?/gm, '');
}

describe('canonical snippets', () => {
  it('has the three the instructions promise', () => {
    expect(files).toHaveLength(3);
  });

  it.each(files)(
    '%s prints its Output block and appears whole in AGENTS.md',
    (file) => {
      if (!existsSync(join(REPO, 'dist/index.js'))) throw new Error('dist missing: run test:examples');
      const source = readFileSync(join(DIR, file), 'utf8');
      const output = execFileSync(process.execPath, ['--import', 'tsx', join(DIR, file)], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      expect(output).toBe(expectedOutput(source));
      expect(readFileSync(join(REPO, 'AGENTS.md'), 'utf8')).toContain(source.trim());
    },
    30_000,
  );
});
