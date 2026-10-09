/**
 * The admitted record (9.30.0) — security: a field mark BELOW an array path.
 *
 * A field redaction addresses an element of the WHOLE array (`list.1.token`).
 * A delta `append` row holds only the tail, so `redactPatch` finds no element 1
 * there and the secret would stay in the commit log and the redacted mirror.
 * `deltaEncoding · pushValueRow` takes the `set` of the whole value whenever a
 * mark sits below the path. Two shapes reach that row:
 *   - `lossyMerge` — a merge family that does not fold back, re-encoded as its
 *     read-back (base + tail); found by the PR #11 review, a 9.30.0 regression;
 *   - `setAppend` — a hard write of base + tail; open since before 9.29.0.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

const SECRET = 'SECRET-tail';

async function run(commitValues: 'full' | 'delta', variant: 'setAppend' | 'lossyMerge') {
  const chart = flowChart<any>(
    'Seed',
    (s) => {
      s.list = [{ id: 1 }];
    },
    'seed',
  )
    .addFunction(
      'Probe',
      (s) => {
        if (variant === 'setAppend') {
          s.list = [...s.list, { id: 3, token: SECRET }];
        } else {
          s.$update('list', [{ id: 2 }]);
          s.$update('list', []);
          s.$update('list', [{ id: 1 }, { id: 3, token: SECRET }]);
        }
      },
      'probe',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { commitValues });
  ex.setRedactionPolicy({ fields: { list: ['1.token'] } });
  await ex.run();
  return ex;
}

describe('a field mark below an array path is never lost to a compact append', () => {
  for (const variant of ['setAppend', 'lossyMerge'] as const) {
    it.each(['full', 'delta'] as const)(
      `${variant}: no secret in the log or the redacted mirror (%s)`,
      async (mode) => {
        const ex = await run(mode, variant);
        const log = JSON.stringify(ex.getSnapshot().commitLog);
        expect(log).not.toContain(SECRET);
        const mirror = ex.getSnapshot({ redact: true }).sharedState as any;
        expect(JSON.stringify(mirror)).not.toContain(SECRET);
        expect(mirror.list[1].token).toBe('REDACTED');
        // The live heap keeps the value (the redaction law never touches it).
        expect((ex.getSnapshot().sharedState as any).list[1].token).toBe(SECRET);
      },
    );
  }
});
