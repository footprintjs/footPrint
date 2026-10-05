import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');
const example = 'examples/building-blocks/02-fork.ts';

describe('fork example — public package integration', () => {
  it('confirms the in-stock, fraud-cleared order after both branches finish', () => {
    // Transpile only: keep the example's public package import, resolved from dist.
    // CI and test:examples build that package before running this guard.
    const { code } = transformSync(readFileSync(resolve(projectRoot, example), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
      target: 'node22',
      sourcefile: example,
    });
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Order ORD-001: confirmed');
    expect(result.stdout).not.toContain('held-for-review');
  });
});
