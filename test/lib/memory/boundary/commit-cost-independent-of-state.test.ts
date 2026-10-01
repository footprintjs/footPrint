/**
 * Copy-on-write commit (9.29.0) — what a write costs does not depend on the
 * state it does not touch (docs/design/2026-10-copy-on-write-commit.md).
 *
 * COUNTED, never timed: per stage, the `structuredClone` calls and the nodes
 * inside every value handed to one, with a big value (a history of N items)
 * sitting in the state, at N = 100 and N = 10,000. Before copy-on-write a
 * stage that wrote anything cloned the WHOLE state three times (twice when
 * its transaction buffer was built, once when its commit was applied — four
 * with a redaction mirror), so both counts grew with N. Now they are the
 * written value's — and a read after the stage's first write pays for the
 * value READ (its private copy, option D), never for the rest of the state.
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

const history = (n: number) => Array.from({ length: n }, (_, i) => ({ i, text: `message ${i}`, meta: { t: i } }));

/**
 * Counts the clones paid from the top of each MEASURED stage's body to the top
 * of the next stage's body (its commit included). `measure(i)` marks the start
 * of measured stage i; `stop()` ends the last one.
 */
async function measure(
  build: (mark: () => void, stop: () => void) => ReturnType<typeof flowChart>,
  options: Record<string, unknown> = {},
  policy = false,
): Promise<Cost[]> {
  const costs: Cost[] = [];
  let current: Cost | undefined;
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, opts?: StructuredSerializeOptions) => {
    if (current) {
      current.calls += 1;
      current.nodes += countNodes(value);
    }
    return real(value, opts);
  }) as typeof structuredClone;
  try {
    const mark = () => {
      current = { calls: 0, nodes: 0 };
      costs.push(current);
    };
    const stop = () => {
      current = undefined;
    };
    const executor = new FlowChartExecutor(build(mark, stop).build(), options);
    if (policy) executor.setRedactionPolicy({ keys: ['unrelatedSecret'] });
    await executor.run();
  } finally {
    globalThis.structuredClone = real;
  }
  return costs;
}

/** seed (history of n) → 5 stages that each write ONE number. */
const oneKeyWrites = (n: number) => (mark: () => void, stop: () => void) => {
  let b = flowChart<Record<string, unknown>>(
    'Seed',
    (scope) => {
      scope.history = history(n);
      scope.profile = { name: 'n', tier: 'gold' };
    },
    'seed',
  );
  for (let i = 0; i < 5; i++) {
    b = b.addFunction(
      `Write${i}`,
      (scope) => {
        mark();
        scope[`k${i}`] = i;
      },
      `write-${i}`,
    );
  }
  return b.addFunction('End', stop, 'end');
};

describe('copy-on-write commit — a one-key write costs the same at any state size', () => {
  for (const commitValues of ['full', 'delta'] as const) {
    for (const policy of [false, true]) {
      it(`commitValues ${commitValues}${
        policy ? ', redacted mirror on' : ''
      }: identical clone counts at N = 100 and N = 10,000`, async () => {
        const small = await measure(oneKeyWrites(100), { commitValues }, policy);
        const large = await measure(oneKeyWrites(10_000), { commitValues }, policy);
        expect(large).toHaveLength(5);
        expect(large).toEqual(small);
        // …and they are the size of the written number, not of the 10k-item history.
        for (const stage of large) expect(stage.nodes).toBeLessThan(20);
      });
    }
  }

  it('a fork child writing one number into its own namespace: the same counts at any state size', async () => {
    const forkWrites = (n: number) => (mark: () => void, stop: () => void) =>
      flowChart<Record<string, unknown>>(
        'Seed',
        (scope) => {
          scope.history = history(n);
        },
        'seed',
      )
        .addFunction('Mark', mark, 'mark')
        .addListOfFunction([
          {
            id: 'a',
            name: 'A',
            fn: (scope: any) => {
              scope.a = 1;
            },
          },
          {
            id: 'b',
            name: 'B',
            fn: (scope: any) => {
              scope.b = 2;
            },
          },
        ])
        .addFunction('End', stop, 'end');
    const small = await measure(forkWrites(100));
    const large = await measure(forkWrites(10_000));
    expect(large).toEqual(small);
    expect(large[0].nodes).toBeLessThan(40);
  });

  it('a subflow merge-back writing NESTED rows (obj.y) beside a big value: the same counts at any state size', async () => {
    const mergeBack = (n: number) => (mark: () => void, stop: () => void) => {
      const inner = flowChart<Record<string, unknown>>(
        'In',
        (scope) => {
          scope.y = 1;
        },
        'in',
      ).build();
      return flowChart<Record<string, unknown>>(
        'Seed',
        (scope) => {
          scope.history = history(n);
          scope.obj = { x: 0 };
        },
        'seed',
      )
        .addFunction('Mark', mark, 'mark')
        .addSubFlowChart('sub', inner, 'Sub', { outputMapper: (out: any) => ({ obj: { y: out.y } }) })
        .addFunction('End', stop, 'end');
    };
    const small = await measure(mergeBack(100));
    const large = await measure(mergeBack(10_000));
    expect(large).toEqual(small);
    expect(large[0].nodes).toBeLessThan(60);
  });

  it('a read AFTER the first write pays for the value read — once — never for the rest of the state', async () => {
    const reads: number[] = [];
    // `history` is read after the stage's first write: its private copy is
    // the one clone that grows with N. The unrelated `blob` (always 10k)
    // never shows up in the count.
    const readBack = (n: number) => (mark: () => void, stop: () => void) =>
      flowChart<Record<string, unknown>>(
        'Seed',
        (scope) => {
          scope.history = history(n);
          scope.blob = history(10_000);
        },
        'seed',
      )
        .addFunction(
          'WriteThenRead',
          (scope: any) => {
            mark();
            scope.k = 1; // first write
            reads.push(scope.$getValue('history').length); // the stage's own copy
            reads.push(scope.$getValue('history').length); // …taken once
          },
          'write-then-read',
        )
        .addFunction('End', stop, 'end');
    const [small] = await measure(readBack(100), { readTracking: 'off' });
    const [large] = await measure(readBack(10_000), { readTracking: 'off' });
    const historyNodes = (n: number) => countNodes(history(n));
    expect(reads).toEqual([100, 100, 10_000, 10_000]);
    expect(small.nodes - historyNodes(100)).toBe(large.nodes - historyNodes(10_000));
    expect(small.nodes - historyNodes(100)).toBeLessThan(20);
  });
});
