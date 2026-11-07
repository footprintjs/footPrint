/** Integration: the finish-inside-body recipe runs against the built public package. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import { minimalChildEnv } from '../../helpers/childProcessEnv.js';

it('runs the finish-inside-body recipe against the built public package', () => {
  const child = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'examples/runtime-features/run-lifecycle/02-finish-inside-body.ts'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: minimalChildEnv(process.env),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('filed inside the turn: turn-1 completed');
});
