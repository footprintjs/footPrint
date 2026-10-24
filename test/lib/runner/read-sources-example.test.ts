import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import { minimalChildEnv } from '../../helpers/childProcessEnv.js';

it('runs the documented source example against the built package, without a provider', () => {
  const child = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'examples/post-execution/snapshot/06-read-sources.ts'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: minimalChildEnv(process.env),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('Native source: base');
});
