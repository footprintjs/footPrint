/**
 * Example 01, RUN — `examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts` asserts its own
 * invariants (a file-sink run reads back complete with the live commits; a run still in flight reads incomplete,
 * with its landed commit and the attempts of the stage that never committed; no redacted value reaches the sink)
 * and exits non-zero on any violation; this test shells out to it and reads the exit code and the closing line.
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
const example = resolve(projectRoot, 'examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts');

describe('examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts', () => {
  it('runs cleanly: stored, incomplete when unfinished, never a secret', () => {
    if (!existsSync(resolve(projectRoot, 'dist/sinks.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ the record outlives the run: stored, incomplete when unfinished, never a secret');
    expect(output).toContain('complete: false (no closing entry), commits landed: 1');
    expect(output).toContain('attempts of the stage that never committed: #1 failed, #2 failed');
  }, 30_000);
});
