/** Integration: the runnable attention example exercises built public package exports without a model/provider. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');

describe('examples/runtime-features/attention/01-stage-attention.ts', () => {
  it('runs the built public healthy/retry/healthy path with resolvable retained proof', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run through npm run test:examples, which builds first.');
    }
    const output = execFileSync(
      process.execPath,
      [
        resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
        resolve(projectRoot, 'examples/runtime-features/attention/01-stage-attention.ts'),
      ],
      { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
    );
    expect(output).toContain('✓ healthy stages omit attention; a recovered retry keeps resolvable local proof');
    expect(output).toMatch(/Inventory attention: retried; proof: inventory#\d+@\d+/);
  }, 30000);
});
