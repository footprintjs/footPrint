/** Agent-free consumer through both built public entry points and independent native processes. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('optional child continuation built package', () => {
  it.each(['cjs', 'esm'])('uses a cold JSON restart and current addressed gate in %s', (format) => {
    const worker = resolve('test/fixtures/child-continuation-host.cjs');
    const run = spawnSync(process.execPath, [worker, format], { encoding: 'utf8', timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      waitingRevisions: [1, 2],
      staleLoaderCalls: 0,
      denialRefunds: 0,
      originalFailure: true,
      receipt: { outcome: 'refunded', receipt: 'refund-order-fixture' },
    });
  });
});
