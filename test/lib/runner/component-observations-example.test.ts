import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import { minimalChildEnv } from '../../helpers/childProcessEnv.js';

it('runs the concurrent component observations recipe against the built public package', () => {
  const child = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'examples/runtime-features/run-lifecycle/01-component-observations.ts'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: minimalChildEnv(process.env),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('alpha.lookup');
  expect(child.stdout).toContain('beta.lookup');
  // The recipe itself checks immediate per-component tools/cost, actual overlap,
  // native occurrence separation and both joined async finalizers.
});
