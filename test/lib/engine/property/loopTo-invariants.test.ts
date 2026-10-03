/**
 * Property test: loopTo invariants.
 *
 * Verifies that loops built with loopTo() maintain key invariants
 * regardless of iteration count, loop target position, or break timing.
 */
import * as fc from 'fast-check';

import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Property: loopTo invariants', () => {
  it('iteration count always equals number of times loop body executed', async () => {
    for (const maxIter of [1, 2, 5, 10]) {
      const chart = flowChart(
        'Body',
        (scope: any) => {
          const n = ((scope.n as number) ?? 0) + 1;
          scope.n = n;
          if (n >= maxIter) scope.$break();
        },
        'body',
      )
        .loopTo('body')
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run({ input: {} });
      const snapshot = executor.getSnapshot();
      expect(snapshot?.sharedState?.n).toBe(maxIter);
    }
  });

  it('breakPipeline in any stage of the loop body stops the entire chain', async () => {
    // breakPipeline in stage 1 of a 3-stage loop body — stages 2 and 3 should not execute
    const order: string[] = [];

    const chart = flowChart(
      'A',
      (scope: any) => {
        order.push('A');
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= 2) scope.$break();
      },
      'a',
    )
      .addFunction(
        'B',
        () => {
          order.push('B');
        },
        'b',
      )
      .addFunction(
        'C',
        () => {
          order.push('C');
        },
        'c',
      )
      .loopTo('a')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    // First pass: A, B, C. Second pass: A breaks — B and C should NOT run.
    expect(order).toEqual(['A', 'B', 'C', 'A']);
  });

  it('scope state is monotonically accumulated across iterations', async () => {
    const chart = flowChart(
      'Append',
      (scope: any) => {
        const log = (scope.log as string[]) ?? [];
        log.push(`iter-${log.length}`);
        scope.log = log;
        if (log.length >= 5) scope.$break();
      },
      'append',
    )
      .loopTo('append')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    const snapshot = executor.getSnapshot();
    const log = snapshot?.sharedState?.log as string[];

    // Each iteration appended exactly one entry
    expect(log).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(log[i]).toBe(`iter-${i}`);
    }
  });

  it('loopTo target position does not affect iteration correctness', async () => {
    // Loop back to middle stage (not root) — Init runs once, Process+Check loop
    const counts = { init: 0, process: 0, check: 0 };

    const chart = flowChart(
      'Init',
      () => {
        counts.init++;
      },
      'init',
    )
      .addFunction(
        'Process',
        () => {
          counts.process++;
        },
        'process',
      )
      .addFunction(
        'Check',
        (scope: any) => {
          counts.check++;
          if (counts.check >= 3) scope.$break();
        },
        'check',
      )
      .loopTo('process')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    expect(counts.init).toBe(1); // Init runs exactly once
    expect(counts.process).toBe(3); // Process runs on every iteration
    expect(counts.check).toBe(3); // Check runs on every iteration
  });

  it('narrative entries grow with each iteration', async () => {
    const chart = flowChart(
      'Step',
      (scope: any) => {
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= 3) scope.$break();
      },
      'step',
    )
      .loopTo('step')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run({ input: {} });

    const narrative = executor.getNarrativeEntries().map((e) => e.text);
    // Each iteration should generate narrative — more iterations = more entries
    expect(narrative.length).toBeGreaterThanOrEqual(3);

    // Step should be mentioned at least 3 times (once per iteration)
    const stepMentions = narrative.filter((line) => line.includes('Step'));
    expect(stepMentions.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * A loop through a decider is the same loop whether or not the decider has a
 * `next` of its own: the stage order with a `next` is the order without it,
 * plus the `next` ONCE at the end — for any pass count, a loop back to the
 * decider or to a stage upstream of it, and at a depth cap of 2 (one nesting
 * level; through 9.39.0 every pass stacked a level).
 */
describe('Property: a decider with its own next loops flat', () => {
  function chart(passes: number, target: 'decide' | 'seed', withNext: boolean) {
    const b = flowChart<any>(
      'Seed',
      async (scope) => {
        if (scope.$getValue('i') === undefined) scope.$setValue('i', 0);
      },
      'seed',
    )
      .addDeciderFunction(
        'Decide',
        async (scope) => ((scope.$getValue('i') as number) < passes ? 'continue' : 'done'),
        'decide',
      )
      .addFunctionBranch(
        'continue',
        'Tick',
        async (scope: any) => {
          scope.$setValue('i', (scope.$getValue('i') as number) + 1);
        },
        undefined,
        { loopTo: target },
      )
      .addFunctionBranch('done', 'Final', async () => {})
      .end();
    return (withNext ? b.addFunction('After', async () => {}, 'after') : b).build();
  }

  async function order(passes: number, target: 'decide' | 'seed', withNext: boolean) {
    const ex = new FlowChartExecutor(chart(passes, target, withNext));
    const seen: string[] = [];
    ex.attachFlowRecorder({ id: 'order', onStageExecuted: (e) => seen.push(e.stageName) });
    await ex.run({ maxDepth: 2 });
    return seen;
  }

  it('stage order with a next = stage order without it + the next once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 120 }),
        fc.constantFrom('decide' as const, 'seed' as const),
        async (passes, target) => {
          const flat = await order(passes, target, false);
          const withNext = await order(passes, target, true);
          expect(withNext).toEqual([...flat, 'After']);
        },
      ),
      { numRuns: 30 },
    );
  });
});

/** Fan-out width never consumes depth: every child runs at a cap of 2. */
describe('Property: fork width is one nesting level', () => {
  it('a fork of any width runs every child at maxDepth 2, in either error mode', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 700 }), fc.boolean(), async (width, failFast) => {
        let ran = 0;
        const children = Array.from({ length: width }, (_, i) => ({
          id: `c${i}`,
          name: `C${i}`,
          fn: async () => {
            ran++;
          },
        }));
        const c = flowChart<any>('Seed', async () => {}, 'seed')
          .addListOfFunction(children, { failFast })
          .build();
        await new FlowChartExecutor(c).run({ maxDepth: 2 });
        expect(ran).toBe(width);
      }),
      { numRuns: 20 },
    );
  });
});
