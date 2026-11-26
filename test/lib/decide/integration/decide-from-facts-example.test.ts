/**
 * Integration: `examples/build-time-features/decide-select/08-decide-from-facts.ts` checks its own promises against
 * the BUILT package and exits non-zero on any violation. It runs only from `npm run test:examples`, which builds first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');

describe('examples/build-time-features/decide-select/08-decide-from-facts.ts', () => {
  it('runs: a rule, the default and a fixed choice, each one record, names only', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run through npm run test:examples, which builds first.');
    }
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', resolve(projectRoot, 'examples/build-time-features/decide-select/08-decide-from-facts.ts')],
      { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
    );
    expect(output).not.toContain('REGRESSION');
    expect(output).toContain(
      '1. a rule chose     : {"strategy":"freight","by":"rule","rule":1,"label":"Too heavy for a parcel","reads":["heavy"]}',
    );
    expect(output).toContain('3. a configured one : {"strategy":"courier","by":"fixed","reads":[],"voucher":"app"}');
    expect(output).toContain('4. evidence         : freight — holds the postcode? false');
    expect(output).toContain('✓ one law, one record: a rule, the default, or a fixed choice — names only');
  }, 30000);
});
