/**
 * Property test: loopTo invariants.
 *
 * Verifies that loops built with loopTo() maintain key invariants
 * regardless of iteration count, loop target position, or break timing.
 */
import type { ScopeFacade } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Property: loopTo invariants', () => {
  it('iteration count always equals number of times loop body executed', async () => {
    for (const maxIter of [1, 2, 5, 10]) {
      const chart = flowChart(
        'Body',
        (scope: ScopeFacade, breakPipeline: () => void) => {
          const n = ((scope.getValue('n') as number) ?? 0) + 1;
          scope.setValue('n', n);
          if (n >= maxIter) breakPipeline();
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
      (scope: ScopeFacade, breakPipeline: () => void) => {
        order.push('A');
        const n = ((scope.getValue('n') as number) ?? 0) + 1;
        scope.setValue('n', n);
        if (n >= 2) breakPipeline();
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
      (scope: ScopeFacade, breakPipeline: () => void) => {
        const log = (scope.getValue('log') as string[]) ?? [];
        log.push(`iter-${log.length}`);
        scope.setValue('log', log);
        if (log.length >= 5) breakPipeline();
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
        (_scope: ScopeFacade, breakPipeline: () => void) => {
          counts.check++;
          if (counts.check >= 3) breakPipeline();
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
      (scope: ScopeFacade, breakPipeline: () => void) => {
        const n = ((scope.getValue('n') as number) ?? 0) + 1;
        scope.setValue('n', n);
        if (n >= 3) breakPipeline();
      },
      'step',
    )
      .loopTo('step')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    const narrative = executor.getNarrative();
    // Each iteration should generate narrative — more iterations = more entries
    expect(narrative.length).toBeGreaterThanOrEqual(3);

    // Step should be mentioned at least 3 times (once per iteration)
    const stepMentions = narrative.filter((line) => line.includes('Step'));
    expect(stepMentions.length).toBeGreaterThanOrEqual(3);
  });
});
