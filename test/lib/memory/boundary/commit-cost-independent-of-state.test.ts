/**
 * Copy-on-write commit (design 2026-10) — what a small write costs does not
 * depend on the state it does not touch.
 *
 * COUNTED, never timed: per stage that writes ONE number, the
 * `structuredClone` calls and the nodes inside every value handed to it,
 * at N = 100 and N = 10,000 history items. Before copy-on-write each such
 * stage cloned the WHOLE state three times (twice when its transaction
 * buffer was built, once when its commit was applied — four with a redaction
 * mirror), so both numbers grew with N. Now they are the written value's.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';

type Cost = { calls: number; nodes: number };

/** Every value inside `v`, containers and leaves — the work a clone of it does. */
function countNodes(v: unknown, seen = new WeakSet<object>()): number {
  if (v === null || typeof v !== 'object') return 1;
  if (seen.has(v)) return 1;
  seen.add(v);
  let n = 1;
  for (const k of Object.keys(v)) n += countNodes((v as Record<string, unknown>)[k], seen);
  return n;
}

/** Per one-key-write stage: the clones from the top of its body to the top of the next stage (its commit included). */
async function costOfOneKeyWrites(n: number, commitValues: 'full' | 'delta', policy: boolean): Promise<Cost[]> {
  const costs: Cost[] = [];
  let current: Cost | undefined;
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (current) {
      current.calls += 1;
      current.nodes += countNodes(value);
    }
    return real(value, options);
  }) as typeof structuredClone;
  try {
    let builder = flowChart<Record<string, unknown>>(
      'Seed',
      (scope) => {
        scope.history = Array.from({ length: n }, (_, i) => ({ i, text: `message ${i}`, meta: { t: i } }));
        scope.profile = { name: 'n', tier: 'gold' };
      },
      'seed',
    );
    for (let i = 0; i < 5; i++) {
      builder = builder.addFunction(
        `Write${i}`,
        (scope) => {
          current = { calls: 0, nodes: 0 };
          costs.push(current);
          scope[`k${i}`] = i;
        },
        `write-${i}`,
      );
    }
    builder = builder.addFunction(
      'End',
      () => {
        current = undefined;
      },
      'end',
    );
    const executor = new FlowChartExecutor(builder.build(), { commitValues });
    if (policy) executor.setRedactionPolicy({ keys: ['unrelatedSecret'] });
    await executor.run();
  } finally {
    globalThis.structuredClone = real;
  }
  return costs;
}

describe('copy-on-write commit — a one-key write costs the same at any state size', () => {
  for (const commitValues of ['full', 'delta'] as const) {
    for (const policy of [false, true]) {
      it(`commitValues ${commitValues}${
        policy ? ', redacted mirror on' : ''
      }: identical clone counts at N = 100 and N = 10,000`, async () => {
        const small = await costOfOneKeyWrites(100, commitValues, policy);
        const large = await costOfOneKeyWrites(10_000, commitValues, policy);
        expect(large).toHaveLength(5);
        expect(large).toEqual(small);
        // …and they are the size of the written number, not of the 10k-item history.
        for (const stage of large) expect(stage.nodes).toBeLessThan(20);
      });
    }
  }
});
