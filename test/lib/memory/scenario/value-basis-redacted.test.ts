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

// Review findings 1 and 4 (F4b): two answers that said 'never-written' and were false.
describe('a removed base value and a hidden write', () => {
  async function snapOf(fn: (s: any) => void, options: Record<string, unknown>, policy?: unknown) {
    const ex = new FlowChartExecutor(flowChart('Only', fn, 'only').build(), options);
    if (policy) ex.setRedactionPolicy(policy as any);
    await ex.run();
    return ex.getSnapshot();
  }
  const K = 'a\u001Fb';

  for (const commitValues of ['full', 'delta'] as const) {
    it(`a run that removed a value the base held answers 'deleted' (${commitValues}: delete, and set of the container)`, async () => {
      const shapes: Array<(s: any) => void> = [
        (s) => {
          delete s.a;
        },
        (s) => {
          s.a = { c: 2 };
        },
      ];
      for (const fn of shapes) {
        const snap = await snapOf(fn, { commitValues, initialContext: { a: { b: 1 } } });
        const log = snap.commitLog as any[];
        const answer = commitValueAtWithBasis(log, log.length - 1, K, { initialState: snap.initialState as any });
        expect(answer.value).toBeUndefined();
        expect(answer.basis).toEqual(['deleted']);
      }
    });
  }

  it("a redaction that replaced the container hides the write: 'redacted' only, never 'never-written'", async () => {
    const snap = await snapOf(
      (s) => {
        s.b = { x: 1 };
      },
      {},
      { keys: ['b'] },
    );
    const log = snap.commitLog as any[];
    expect(commitValueAtWithBasis(log, log.length - 1, 'b\u001Fx')).toEqual({ value: undefined, basis: ['redacted'] });
  });
});
