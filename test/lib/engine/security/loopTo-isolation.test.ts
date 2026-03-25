/**
 * Security: loopTo isolation and safety guarantees.
 *
 * Verifies that loopTo cannot be used to:
 * - Bypass iteration limits (runaway loop protection)
 * - Corrupt scope state across iterations
 * - Leak state between independent loop runs
 * - Escape the flowchart boundary via crafted stage ids
 */
import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Security: loopTo isolation', () => {
  it('iteration limit cannot be bypassed by resetting scope state', async () => {
    // A malicious stage function cannot reset the iteration counter
    // because it lives in ContinuationResolver, not in scope
    let count = 0;

    const chart = flowChart(
      'Tricky',
      (scope: any) => {
        count++;
        // Try to reset any loop-related state
        scope.loopCount = 0;
        scope.iteration = 0;
        scope.__iteration = 0;
      },
      'tricky',
    )
      .loopTo('tricky')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ input: {} })).rejects.toThrow(/[Mm]aximum.*iterations.*exceeded/);
    // Still enforced despite attempts to reset
    expect(count).toBeGreaterThan(100);
  });

  it('loop does not leak state between separate executor runs', async () => {
    const chart = flowChart(
      'Accumulate',
      (scope: any) => {
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= 3) scope.$break();
      },
      'accumulate',
    )
      .loopTo('accumulate')
      .build();

    // Run 1
    const exec1 = new FlowChartExecutor(chart);
    await exec1.run({ input: {} });
    const snap1 = exec1.getSnapshot();

    // Run 2 — should start fresh, not continue from run 1
    const exec2 = new FlowChartExecutor(chart);
    await exec2.run({ input: {} });
    const snap2 = exec2.getSnapshot();

    expect(snap1?.sharedState?.n).toBe(3);
    expect(snap2?.sharedState?.n).toBe(3); // Same result — not 6
  });

  it('breakPipeline halts the loop — no further iterations after break', async () => {
    let loopBodyRuns = 0;

    const chart = flowChart(
      'Body',
      (scope: any) => {
        loopBodyRuns++;
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= 3) {
          scope.$break();
          // Code after break still runs in THIS function call,
          // but the loop will not re-execute after this stage returns.
        }
      },
      'body',
    )
      .loopTo('body')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    // Exactly 3 runs: iterations 1, 2, then 3 (which breaks)
    expect(loopBodyRuns).toBe(3);
    // No additional iterations occurred after the break
    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.n).toBe(3);
  });

  it('loopTo build-time validation prevents injection of arbitrary stage ids', () => {
    // Cannot use loopTo to reference stages that don't exist
    expect(() => {
      flowChart('A', () => {}, 'a').loopTo('../../secret-stage');
    }).toThrow('target not found');

    expect(() => {
      flowChart('A', () => {}, 'a').loopTo('');
    }).toThrow('target not found');

    expect(() => {
      flowChart('A', () => {}, 'a').loopTo('__proto__');
    }).toThrow('target not found');
  });

  it('frozen input (getArgs) remains unchanged across loop iterations', async () => {
    const inputData = { secret: 'original', counter: 0 };

    const chart = flowChart(
      'ReadOnly',
      (scope: any) => {
        const args = scope.$getArgs<typeof inputData>();
        // Verify input is still original on every iteration
        if (args.secret !== 'original') {
          throw new Error('Input was mutated!');
        }
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        if (n >= 5) scope.$break();
      },
      'read-only',
    )
      .loopTo('read-only')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: inputData });
    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.n).toBe(5);
  });
});
