/**
 * Integration: `examples/runtime-features/redaction/05-decision-evidence.ts` checks its own promises against the BUILT
 * package and exits non-zero on any violation. It runs only from `npm run test:examples`, which builds first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');

describe('examples/runtime-features/redaction/05-decision-evidence.ts', () => {
  it('runs: a selected threshold is a named hole, a clear one stays a value', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run through npm run test:examples, which builds first.');
    }
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', resolve(projectRoot, 'examples/runtime-features/redaction/05-decision-evidence.ts')],
      { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
    );
    expect(output).toContain('✓ the secret is on no surface; the clear threshold still explains the decision');
    expect(output).toContain('ssn: threshold [REDACTED], thresholdRedacted true');
    expect(output).toContain('amount: threshold 500, thresholdRedacted false');
  }, 30000);
});
