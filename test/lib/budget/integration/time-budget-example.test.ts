/**
 * The time-budget example, RUN — `examples/build-time-features/budget/01-time-budget.ts` asserts its own invariants
 * (the worked example refused at build with its numbers, a kept budget reported with its unbounded stage named, a
 * loop bounded only by an assumption) and exits non-zero on any violation; this test shells out to it and reads the
 * exit code and the closing line.
 *
 * The example imports `footprintjs`, which resolves to `dist/`, so this runs only from `npm run test:examples`
 * (vitest.examples.config.ts builds first); it never builds itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');
const example = resolve(projectRoot, 'examples/build-time-features/budget/01-time-budget.ts');

describe('examples/build-time-features/budget/01-time-budget.ts', () => {
  it('runs cleanly: refused at build, reported, bounded by an assumption', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ refused at build, reported, and bounded by an assumption');
    expect(output).toContain('over its budget by 48000 ms');
  }, 30_000);
});
