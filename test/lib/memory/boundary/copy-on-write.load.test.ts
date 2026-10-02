/**
 * Copy-on-write commit (9.29.0) — load, COUNTED (never a wall-clock budget).
 *
 * Hundreds of commits with a large value the run never touches: the total
 * `structuredClone` work of the whole run is the same whether that value
 * holds 10 items or 20,000. Before 9.29.0 every writing stage cloned it three
 * times, so the total grew as stages × size.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';

/** Total nodes handed to `structuredClone` while `fn` runs. */
async function clonedNodes(fn: () => Promise<void>): Promise<number> {
  let nodes = 0;
  const count = (v: unknown, seen: WeakSet<object>): number => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return 1;
    seen.add(v);
    let n = 1;
    for (const k of Object.keys(v)) n += count((v as Record<string, unknown>)[k], seen);
    return n;
  };
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    nodes += count(value, new WeakSet());
    return real(value, options);
  }) as typeof structuredClone;
  try {
    await fn();
  } finally {
    globalThis.structuredClone = real;
  }
  return nodes;
}

const blob = (n: number) => Array.from({ length: n }, (_, i) => ({ i, meta: { t: i } }));

/**
 * The once-per-runtime cost of the seed: the store detaches it and the log
 * clones its fold base — and the executor builds a runtime at construction
 * and again at `run()`. Measured on a chart that writes nothing.
 */
const seedCost = (n: number) =>
  clonedNodes(async () => {
    await new FlowChartExecutor(flowChart<any>('Only', () => undefined, 'only').build(), {
      initialContext: { blob: blob(n) },
    }).run();
  });

describe('copy-on-write — load: the untouched part of the state costs nothing, however many commits', () => {
  it.each(['full', 'delta'] as const)(
    '400 one-key stages: the same total clone work beside 10 or 20,000 items (%s)',
    async (commitValues) => {
      const total = async (n: number) => {
        let b = flowChart<any>('Seed', () => undefined, 'seed');
        for (let i = 0; i < 400; i++) {
          b = b.addFunction(
            `W${i}`,
            (s: any) => {
              s[`k${i % 7}`] = i;
            },
            `w-${i}`,
          );
        }
        // The blob arrives with the run (initialContext), so no stage writes it.
        return clonedNodes(async () => {
          await new FlowChartExecutor(b.build(), { commitValues, initialContext: { blob: blob(n) } }).run();
        });
      };
      const small = (await total(10)) - (await seedCost(10));
      const large = (await total(20_000)) - (await seedCost(20_000));
      expect(large).toBe(small);
      expect(small).toBeLessThan(400 * 10);
    },
  );

  it('an agent loop — push a turn, tick a counter, read the history — pays for the history, never for the blob', async () => {
    const looked: number[] = [];
    const run = async (n: number) => {
      let b = flowChart<any>(
        'Seed',
        (s: any) => {
          s.history = [];
          s.turn = 0;
        },
        'seed',
      );
      for (let t = 0; t < 60; t++) {
        b = b
          .addFunction(
            `Push${t}`,
            (s: any) => {
              s.history.push({ role: 'user', text: `turn ${t}` });
            },
            `push-${t}`,
          )
          .addFunction(
            `Tick${t}`,
            (s: any) => {
              s.turn = t + 1;
            },
            `tick-${t}`,
          )
          .addFunction(
            `Look${t}`,
            (s: any) => {
              looked.push(s.history.length);
            },
            `look-${t}`,
          );
      }
      return clonedNodes(async () => {
        await new FlowChartExecutor(b.build(), { initialContext: { blob: blob(n) } }).run();
      });
    };
    expect((await run(20_000)) - (await seedCost(20_000))).toBe((await run(10)) - (await seedCost(10)));
    expect(looked.slice(0, 60)).toEqual(Array.from({ length: 60 }, (_, t) => t + 1));
  });
});
