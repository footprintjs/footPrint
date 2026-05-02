/**
 * Integration test — runs every example under
 * `examples/runtime-features/detach/` end-to-end via tsx, asserting
 * that each one prints `OK` on its last line and exits with code 0.
 *
 * The example scripts contain their own regression guards (they call
 * `process.exit(1)` on any invariant violation) — this test just
 * shells out to them and treats the exit code as the verdict.
 *
 * If you add a new example file, this test picks it up automatically
 * via the `Detach examples` glob discovery — no test edit needed.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const examplesDir = resolve(__dirname, '../../../examples/runtime-features/detach');

// Discover .ts files (skip .md / README / hidden).
const exampleFiles = readdirSync(examplesDir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort();

describe('detach/examples — integration', () => {
  it('discovers at least 8 examples (regression guard against accidental deletion)', () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of exampleFiles) {
    it(`example ${file} runs cleanly and prints OK`, () => {
      const fullPath = join(examplesDir, file);
      let output = '';
      try {
        output = execFileSync('npx', ['tsx', fullPath], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch (err) {
        const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '';
        const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
        throw new Error(
          `Example ${file} exited with code ${e.status}.\n` + `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      // Last non-empty line must start with "OK".
      const lines = output.trim().split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      expect(lastLine).toMatch(/^OK/);
    }, 30_000);
  }
});
