/**
 * Boundary test: loopTo edge cases.
 *
 * Tests loopTo behavior at architectural limits:
 * - Max iteration enforcement
 * - Single-iteration loops (break immediately)
 * - Abort signal during loop
 * - Timeout during loop
 * - loopTo builder validation
 */
import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Boundary: loopTo edge cases', () => {
  it('single-iteration loop: break on first pass', async () => {
    let execCount = 0;

    const chart = flowChart(
      'Once',
      (scope: any) => {
        execCount++;
        scope.$break();
      },
      'once',
    )
      .loopTo('once')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    expect(execCount).toBe(1);
  });

  it('ContinuationResolver enforces max iterations and throws', async () => {
    // Default max is 1000 — use a tight loop that never breaks
    let count = 0;

    const chart = flowChart(
      'Infinite',
      () => {
        count++;
      },
      'infinite',
    )
      .loopTo('infinite')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ input: {} })).rejects.toThrow(/[Mm]aximum.*iterations.*exceeded/);
    // Should have run many times before throwing
    expect(count).toBeGreaterThan(100);
  });

  it('abort signal stops loop mid-iteration', async () => {
    const controller = new AbortController();
    let iterations = 0;

    const chart = flowChart(
      'Abortable',
      () => {
        iterations++;
        if (iterations >= 5) controller.abort();
      },
      'abortable',
    )
      .loopTo('abortable')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow();
    expect(iterations).toBeGreaterThanOrEqual(5);
  });

  it('timeout stops loop', async () => {
    const chart = flowChart(
      'Slow',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      'slow',
    )
      .loopTo('slow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ timeoutMs: 50 })).rejects.toThrow();
  });

  it('loopTo builder throws for unknown stage id', () => {
    expect(() => {
      flowChart('A', () => {}, 'a').loopTo('nonexistent');
    }).toThrow('target not found');
  });

  it('loopTo builder throws for stage name instead of id', () => {
    expect(() => {
      flowChart('StageOne', () => {}, 'stage-one')
        .addFunction('StageTwo', () => {}, 'stage-two')
        .loopTo('StageOne'); // name, not id
    }).toThrow('target not found');
  });

  it('loopTo builder throws if loopTo already defined on cursor', () => {
    expect(() => {
      flowChart('A', () => {}, 'a')
        .addFunction('B', () => {}, 'b')
        .loopTo('a')
        .loopTo('a');
    }).toThrow(/loopTo already defined|next is already defined|cursor/i);
  });

  it('scope values survive high iteration counts', async () => {
    const targetIterations = 100;

    const chart = flowChart(
      'Counter',
      (scope: any) => {
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= targetIterations) scope.$break();
      },
      'counter',
    )
      .loopTo('counter')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });
    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.n).toBe(targetIterations);
  });
});
