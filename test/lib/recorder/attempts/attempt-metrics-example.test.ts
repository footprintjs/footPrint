/** Public package + stored-record navigation integration; uses only local synthetic data. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';
it('navigates a physical exemplar to the stored causal stage and committed state', () => {
  const projectRoot = resolve(__dirname, '../../../..');
  const output = execFileSync(
    'npx',
    ['tsx', resolve(projectRoot, 'examples/runtime-features/retry/07-attempt-metrics-and-trace.ts')],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
  );
  expect(output).toContain('✓ metric exemplar → stored trace → causal stage and committed state; no model required');
}, 30000);
