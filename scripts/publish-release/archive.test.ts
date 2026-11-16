import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { it } from 'vitest';

const CHILD_TIMEOUT = 90_000;

it(
  'runs the adjacent canonical-archive and manifest contract under the package gate',
  () => {
    const directory = resolve('scripts/publish-release/archive');
    const tests = readdirSync(directory)
      .filter((name) => name.endsWith('.test.cjs'))
      .sort();
    execFileSync(process.execPath, ['--test', ...tests.map((name) => resolve(directory, name))], {
      timeout: CHILD_TIMEOUT,
      maxBuffer: 1024 * 1024,
      stdio: 'pipe',
    });
  },
  CHILD_TIMEOUT + 5_000,
);
