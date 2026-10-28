/**
 * Example 08, RUN — `examples/runtime-features/retry/08-backoff-helpers.ts` asserts its own invariants (every wait
 * drawn once from the seeded source, recorded and announced as drawn, inside its equal-jitter band; a stated wait wins
 * over the schedule; `attempt()` waits the same schedule) and exits non-zero on any violation; this test shells out to
 * it and reads the exit code and the closing line.
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
const example = resolve(projectRoot, 'examples/runtime-features/retry/08-backoff-helpers.ts');

describe('examples/runtime-features/retry/08-backoff-helpers.ts', () => {
  it('runs cleanly: the schedule, the stated wait, and attempt()', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain(
      '✓ every wait drawn once, recorded, inside its band; the stated wait won; attempt() agrees',
    );
    expect(output).toMatch(/attempt 1: failed → waited \d+\.\dms \(ceiling 20ms\)/);
    expect(output).toContain('the service said "retry after 35ms": waited 35.0ms');
  }, 30_000);
});
