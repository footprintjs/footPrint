/**
 * Example 05, RUN — `examples/runtime-features/retry/05-attempts-inside-a-stage.ts` asserts its own invariants (a
 * single call leaves one record; a retried call keeps every attempt under one series, with its category and
 * decision; an SDK's own attempts are reported as observed; `attempt()` works outside a chart) and exits non-zero on
 * any violation; this test shells out to it and reads the exit code and the closing line.
 *
 * Test types: Integration (the example against the BUILT package).
 *
 * The example imports `footprintjs`, which resolves to `dist/`, so this runs only from `npm run test:examples`
 * (vitest.examples.config.ts builds first); it never builds itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');
const example = resolve(projectRoot, 'examples/runtime-features/retry/05-attempts-inside-a-stage.ts');

describe('examples/runtime-features/retry/05-attempts-inside-a-stage.ts', () => {
  it('runs cleanly: single, retried, observed, and outside a chart', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ every call recorded: single, retried, observed, and outside a chart');
    expect(output).toMatch(/Call inventory\.lookup succeeded in \d+ms\./);
    expect(output).toMatch(/Observed: the payments SDK made attempt 1 of 3, failed in \d+ms/);
  }, 30_000);
});
