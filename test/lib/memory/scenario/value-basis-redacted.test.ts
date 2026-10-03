/**
 * Scenario — a redacted merge-back answers WITH the code (F4b, 9.33.0).
 *
 * F3 made `commitValueAt(cfg)` see the outputMapper's merge-back row `cfg␟b`, so a redacted field answers
 * `{ b: 'REDACTED' }` where it answered `undefined`. The placeholder is the log's honest bytes, but a caller
 * reading the value alone cannot tell it from data: `commitValueAtWithBasis` says `'redacted'` (asked of the
 * bundle's `redactedPaths`, never of the string), plus `'nested-rows'` / `'from-initial-state'` — the value
 * rests on a write inside the key and no whole write of it.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';
import { LOG_PLACEHOLDER } from '../../../../src/lib/memory/placeholders';
import { commitValueAt, commitValueAtWithBasis, HONESTY_CODES } from '../../../../src/trace';

async function run(policy: boolean) {
  const inner = flowChart(
    'Inner',
    (s: any) => {
      s.token = 'secret';
    },
    'inner',
  ).build();
  const chart = flowChart(
    'Start',
    (s: any) => {
      s.other = 1;
    },
    'start',
  )
    .addSubFlowChart('sub', inner, 'Sub', {
      inputMapper: () => ({}),
      outputMapper: (out: any) => ({ cfg: { b: out.token } }),
    })
    .addFunction(
      'After',
      (s: any) => {
        s.done = true;
      },
      'after',
    )
    .build();
  const ex = new FlowChartExecutor(chart);
  if (policy) ex.setRedactionPolicy({ fields: { cfg: ['b'] } });
  await ex.run();
  return ex.getSnapshot();
}

describe('a redacted merge-back', () => {
  it("answers the log's placeholder WITH 'redacted' — and without a policy, the same shape without it", async () => {
    const snap = await run(true);
    const log = snap.commitLog as any[];
    const end = log.length - 1;
    expect(commitValueAt(log, end, 'cfg')).toEqual({ b: LOG_PLACEHOLDER });
    const { value, basis } = commitValueAtWithBasis(log, end, 'cfg');
    expect(value).toEqual({ b: LOG_PLACEHOLDER });
    expect(basis).toContain('redacted');
    expect(basis).toContain('nested-rows');
    for (const code of basis) expect(HONESTY_CODES[code]).toBeTruthy();

    const plain = await run(false);
    const plainLog = plain.commitLog as any[];
    const answer = commitValueAtWithBasis(plainLog, plainLog.length - 1, 'cfg');
    expect(answer.value).toEqual({ b: 'secret' });
    expect(answer.basis).not.toContain('redacted');
  });
});
