/** Built-package P3b example: provider-neutral reconciliation, then a stable-key resend. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');
const example = resolve(projectRoot, 'examples/runtime-features/retry/06-explicit-reconciliation.ts');

describe('explicit retry-loop built package example', () => {
  it('reconciles before another keyed send through the public package', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) throw new Error('dist missing: run test:examples');
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ explicit retry: reconcile, same key, then retry; no provider lock-in');
  }, 30_000);
});
