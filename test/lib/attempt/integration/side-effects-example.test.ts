/**
 * Example 04, RUN — `examples/runtime-features/retry/04-side-effects-and-idempotency.ts` asserts its own invariants
 * (the build refuses a retried touch with no key; one key per execution, on every attempt; a timeout is effect
 * unknown and the run fails with `UnknownEffectError`; the caller reconciles by the key; the adapter's
 * `effect: 'none'` keeps the stage's own error) and exits non-zero on any violation; this test shells out to it and
 * reads the exit code and the closing line.
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
const example = resolve(projectRoot, 'examples/runtime-features/retry/04-side-effects-and-idempotency.ts');

describe('examples/runtime-features/retry/04-side-effects-and-idempotency.ts', () => {
  it('runs cleanly: refused at build, one key per execution, unknown effect reconciled', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ no blind retry: refused without a key, unknown effects reconciled by the key');
    expect(output).toMatch(/effect on payments unknown/);
  }, 30_000);
});
